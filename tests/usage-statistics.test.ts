import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { chatDetailsUri, usageStatisticsUri } from "../src/composer-contract.ts";
import type { DashboardSnapshot, UsageStatistics } from "../src/dashboard-types.ts";
import { UsageStore } from "../src/usage-store.ts";

const workspace = join(tmpdir(), "codex-statistics-workspace");
const otherWorkspace = join(tmpdir(), "codex-statistics-other-workspace");
const firstThread = "11111111-1111-4111-8111-111111111111";
const secondThread = "22222222-2222-4222-8222-222222222222";
const emptyThread = "33333333-3333-4333-8333-333333333333";

function request(usage: unknown, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PostModelRequest",
    cwd: workspace,
    session_id: firstThread,
    model: "first-model",
    status: "completed",
    token_usage: usage,
    ...extra,
  };
}

test("usage statistics include all requests while a selected chat stays in its original workspace", (context) => {
  const store = new UsageStore(":memory:");
  context.after(() => store.close());
  const now = Date.parse("2026-11-20T01:00:00Z");

  for (let index = 0; index < 151; index += 1) {
    store.ingest(request({ total_tokens: 2 }), now - index);
  }
  store.ingest(request({ total_tokens: 4 }, { cwd: otherWorkspace, session_id: secondThread }), now);
  store.ingest(request({ total_tokens: 70 }, { cwd: otherWorkspace }), now);
  store.ingest({ hook_event_name: "PostCompact", cwd: workspace, session_id: firstThread }, now - 86_400_000);

  assert.equal(store.readUsageStatistics(2026, undefined, now).totals.all, 306);
  assert.deepEqual(store.readUsageStatistics(2026, firstThread, now), {
    year: 2026,
    today: "2026-11-20",
    firstDate: "2026-11-20",
    totals: { today: 302, week: 302, month: 302, all: 302 },
    days: [{
      date: "2026-11-20", model: "first-model", totalTokens: 302,
      uncachedInputTokens: null, cachedInputTokens: null, outputTokens: null,
    }],
  });
  assert.deepEqual(store.readUsageStatistics(2026, emptyThread, now), {
    year: 2026,
    today: "2026-11-20",
    firstDate: null,
    totals: { today: null, week: null, month: null, all: null },
    days: [],
  });
});

test("usage statistics group requests by Beijing dates and start the week on Monday", (context) => {
  const store = new UsageStore(":memory:");
  context.after(() => store.close());
  const records = [
    ["2025-12-31T15:59:59.999Z", 6, "first-model"],
    ["2025-12-31T16:00:00.000Z", 15, "first-model"],
    ["2026-01-04T15:59:59.999Z", 21, "first-model"],
    ["2026-01-04T16:00:00.000Z", 14, "first-model"],
    ["2026-01-04T16:00:00.001Z", 18, "first-model"],
    ["2026-01-04T16:00:00.002Z", 3, "second-model"],
  ] as const;
  for (const [timestamp, total, model] of records) {
    store.ingest(request({ total_tokens: total }, { model }), Date.parse(timestamp));
  }

  const now = Date.parse("2026-01-04T16:00:00.003Z");
  const statistics = store.readUsageStatistics(2026, undefined, now);
  assert.equal(statistics.firstDate, "2025-12-31");
  assert.equal(statistics.today, "2026-01-05");
  assert.deepEqual(statistics.totals, { today: 35, week: 35, month: 71, all: 77 });
  assert.deepEqual(statistics.days.map(({ date, model, totalTokens }) => [date, model, totalTokens]), [
    ["2026-01-01", "first-model", 15],
    ["2026-01-04", "first-model", 21],
    ["2026-01-05", "first-model", 32],
    ["2026-01-05", "second-model", 3],
  ]);
  const previous = store.readUsageStatistics(2025, undefined, now);
  assert.deepEqual(previous.totals, statistics.totals);
  assert.deepEqual(previous.days.map(({ date, totalTokens }) => [date, totalTokens]), [["2025-12-31", 6]]);
});

test("usage statistics retain missing amounts and only subtract valid cached counts from input", (context) => {
  const store = new UsageStore(":memory:");
  context.after(() => store.close());
  const firstDay = Date.parse("2026-05-01T00:00:00Z");

  store.ingest(request({ input_tokens: 10, output_tokens: 2 }), firstDay);
  store.ingest(request({ cached_input_tokens: 3 }), firstDay);
  store.ingest(request({ input_tokens: 4, cached_input_tokens: 6, output_tokens: 0 }), firstDay);
  store.ingest(request({ input_tokens: 11, cached_input_tokens: 3, total_tokens: 13 }), firstDay);
  store.ingest(request({ input_tokens: 4, cached_input_tokens: 4, output_tokens: 0, total_tokens: 0 }),
    Date.parse("2026-05-02T00:00:00Z"));
  store.ingest(request(null, { model: null, status: "failed" }), Date.parse("2026-05-03T00:00:00Z"));

  const now = Date.parse("2026-05-03T01:00:00Z");
  const statistics = store.readUsageStatistics(2026, undefined, now);
  assert.deepEqual(statistics.days, [
    {
      date: "2026-05-01", model: "first-model", totalTokens: 13,
      uncachedInputTokens: 8, cachedInputTokens: 12, outputTokens: 2,
    },
    {
      date: "2026-05-02", model: "first-model", totalTokens: 0,
      uncachedInputTokens: 0, cachedInputTokens: 4, outputTokens: 0,
    },
    {
      date: "2026-05-03", model: null, totalTokens: null,
      uncachedInputTokens: null, cachedInputTokens: null, outputTokens: null,
    },
  ]);
  assert.deepEqual(statistics.totals, { today: null, week: 13, month: 13, all: 13 });
  assert.deepEqual(store.readUsageStatistics(2026, undefined, Date.parse("2026-06-01T00:00:00Z")).totals,
    { today: 0, week: 0, month: 0, all: 13 });
});

test("usage statistics leave a legacy chat with multiple workspace matches empty", (context) => {
  const folder = mkdtempSync(join(tmpdir(), "codex-usage-statistics-"));
  const file = join(folder, "usage.sqlite");
  const store = new UsageStore(file);
  context.after(() => {
    store.close();
    rmSync(file);
    rmdirSync(folder);
  });
  const now = Date.parse("2026-11-20T01:00:00Z");
  const location = store.ingest(request({ total_tokens: 3 }), now);
  assert.ok(location);
  const legacy = new DatabaseSync(file);
  try {
    legacy.prepare("INSERT INTO chats (workspace, id, opened_at) VALUES (?, ?, ?)")
      .run("other-workspace-key", location.chat, now);
  } finally {
    legacy.close();
  }

  assert.equal(store.readUsageStatistics(2026, undefined, now).totals.all, 3);
  const scoped = store.readUsageStatistics(2026, firstThread, now);
  assert.equal(scoped.firstDate, null);
  assert.deepEqual(scoped.days, []);
});

test("the MCP statistics resource reads local and chat scopes through its validated URI", { timeout: 10_000 }, async (context) => {
  const profile = mkdtempSync(join(tmpdir(), "codex-statistics-mcp-"));
  const dataDirectory = join(profile, "codex-context-dashboard");
  const database = join(dataDirectory, "usage.sqlite");
  const serverFile = join(profile, "server.cjs");
  const client = new Client({ name: "usage-statistics-test", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    for (const file of [database, `${database}-wal`, `${database}-shm`, serverFile]) rmSync(file, { force: true });
    rmdirSync(dataDirectory);
    rmdirSync(profile);
  });
  mkdirSync(dataDirectory);
  const store = new UsageStore(database);
  try {
    const timestamp = Date.parse("2026-11-20T01:00:00Z");
    store.ingest(request({ total_tokens: 2 }), timestamp);
    store.ingest(request({ total_tokens: 4 }, { cwd: otherWorkspace, session_id: secondThread }), timestamp);
  } finally {
    store.close();
  }
  await build({
    entryPoints: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    platform: "node", target: "node24", format: "cjs", bundle: true, outfile: serverFile,
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverFile], env: { CODEX_HOME: profile } }));

  async function readJson<T>(uri: string): Promise<T> {
    const { contents: [resource] } = await client.readResource({ uri });
    assert.ok(resource && "text" in resource);
    assert.equal(resource.mimeType, "application/json");
    return JSON.parse(resource.text) as T;
  }

  const registered = await client.listResourceTemplates();
  assert.ok(registered.resourceTemplates.some(({ uriTemplate }) => uriTemplate === usageStatisticsUri("{year}", "{target}")));
  const local = await readJson<UsageStatistics>(usageStatisticsUri(2026));
  assert.equal(local.year, 2026);
  assert.equal(local.totals.all, 6);
  const chat = await readJson<UsageStatistics>(usageStatisticsUri(2026, firstThread));
  assert.equal(chat.totals.all, 2);
  assert.equal(chat.firstDate, "2026-11-20");
  const details = await readJson<DashboardSnapshot["session"]>(chatDetailsUri(firstThread));
  assert.equal(details.totals?.totalTokens, 2);
  await assert.rejects(client.readResource({ uri: usageStatisticsUri(2026, "invalid-target") }), /Invalid local chat identifier/);
  await assert.rejects(client.readResource({ uri: usageStatisticsUri(202, "local") }), /Invalid statistics year/);
});
