import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeChatUsage } from "../composer/native-usage.ts";
import { decodeSnapshot, encodeSnapshot, sessionIdFromSidebar } from "../src/composer-contract.ts";
import type { AccountSnapshot, SessionTotals } from "../src/dashboard-types.ts";
import { UsageStore } from "../src/usage-store.ts";

test("accepts the native cumulative snapshot only for the selected local chat", () => {
  const notice = { type: "mcp-notification", method: "thread/tokenUsage/updated", hostId: "local", params: {
    threadId: "opened-chat",
    tokenUsage: {
      total: { totalTokens: 6500, inputTokens: 6000, outputTokens: 500, cachedInputTokens: 3000 },
      last: { totalTokens: 13, inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 },
    },
  } };
  assert.deepEqual(nativeChatUsage(notice, "opened-chat"), {
    totalTokens: 6500, inputTokens: 6000, outputTokens: 500, cacheHitPercent: 50,
  });
  assert.equal(nativeChatUsage(notice, "other-chat"), null);
  assert.equal(nativeChatUsage({ ...notice, hostId: "remote-host" }, "opened-chat"), null);
  assert.equal(nativeChatUsage({ ...notice, params: { threadId: "opened-chat" } }, "opened-chat"), null);
});

test("matches desktop sidebar IDs to local hook IDs without unwrapping a different thread kind", () => {
  const id = "01a1ef89-1111-7111-a111-111111111111";
  assert.equal(sessionIdFromSidebar(`local:${id}`), id);
  assert.equal(sessionIdFromSidebar(id), id);
  assert.equal(sessionIdFromSidebar(`chatgpt:${id}`), `chatgpt:${id}`);
  assert.equal(sessionIdFromSidebar(null), null);
});

test("the composer feed preserves separate summaries across workspaces and registers a chat before its first reply", () => {
  const folder = mkdtempSync(join(tmpdir(), "codex-preview-"));
  const css = join(folder, "effect.css");
  const store = new UsageStore(join(folder, "usage.sqlite"));
  try {
    const feed = store.composerFeed(css);
    const request = (id: string, total: number, cwd = folder) => store.ingest({
      hook_event_name: "PostModelRequest", session_id: id, status: "completed", cwd,
      model: "test-model", prompt: "private text", token_usage: {
        total_tokens: total, input_tokens: total - 10, cached_input_tokens: 20, output_tokens: 10,
      },
    });
    const otherWorkspace = join(folder, "other");
    const start = (id: string, source = "startup", cwd = folder) => store.ingest({
      hook_event_name: "SessionStart", session_id: id, source, cwd,
    });
    const extract = (chat: string) => decodeSnapshot<SessionTotals>(readFileSync(css, "utf8").match(
      new RegExp(`data-usage-key="${chat}"[^\\n]+(--cup-chat-snapshot): ("[^"]+")`),
    )?.[2] ?? "");
    const old = request("old-thread", 90)!;
    feed.updateChat(old);
    assert.equal(extract(old.chat)?.partial, true);
    assert.equal(extract(old.chat)?.requests, 1);
    start("resumed-thread", "resume");
    assert.equal(request("resumed-thread", 90)?.request, true);
    const enrolled = start("work-a")!;
    feed.updateChat(enrolled);
    assert.equal(extract(enrolled.chat)?.requests, 0);
    start("work-b", "startup", otherWorkspace);
    assert.equal(request("work-b", 90), undefined);
    const a = request("work-a", 90)!;
    const b = request("work-b", 50, otherWorkspace)!;
    feed.updateChat(a);
    feed.updateChat(b);
    feed.updateChat(request("work-a", 130)!);
    const sheet = readFileSync(css, "utf8");
    assert(!/private text|test-model|work-a|work-b|old-thread/.test(sheet));
    assert.notEqual(a.workspace, b.workspace);
    assert.equal(extract(a.chat)?.totalTokens, 220);
    assert.equal(extract(a.chat)?.cacheHitPercent, 20);
    assert.equal(extract(b.chat)?.totalTokens, 50);
    assert.equal(extract(b.chat)?.requests, 1);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the feed waits one minute between account refreshes and retains the last successful value", () => {
  const folder = mkdtempSync(join(tmpdir(), "codex-preview-"));
  const css = join(folder, "effect.css");
  const store = new UsageStore(join(folder, "usage.sqlite"));
  try {
    const feed = store.composerFeed(css);
    const now = 1_000_000;
    assert.equal(feed.claimAccountRefresh(now), true);
    assert.equal(feed.claimAccountRefresh(now + 59_999), false);
    assert.equal(feed.claimAccountRefresh(now + 60_000), true);
    const account: AccountSnapshot = {
      quota: { status: "ready", updatedAt: now, windows: [
        { id: "primary", label: "5 小时", usedPercent: 60, durationMinutes: 300, resetsAt: null },
      ] },
      usage: { status: "unavailable", updatedAt: null, days: [] },
    };
    feed.updateAccount(account);
    feed.updateAccount({ ...account, quota: { status: "unavailable", updatedAt: null, windows: [] } });
    assert(readFileSync(css, "utf8").includes(encodeSnapshot(account)));
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
