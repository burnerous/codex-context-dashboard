import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { UsageStore } from "../src/usage-store.ts";

const workspace = resolve(tmpdir(), "codex-dashboard-workspace");
const otherWorkspace = resolve(tmpdir(), "codex-dashboard-other");
const time = 1_800_000_000_000;

function event(kind: string, session: string, data: Record<string, unknown> = {}) {
  return { hook_event_name: kind, cwd: workspace, session_id: session, ...data };
}

function openFor(store: UsageStore, session: string, cwd = workspace) {
  const viewId = store.openView(time);
  store.ingest(event("PostToolUse", session, {
    cwd,
    tool_name: "mcp__codex_usage_dashboard__open_usage_dashboard",
    tool_response: { structuredContent: { viewId } },
  }), time);
  return viewId;
}

function request(session: string, usage: unknown, extra: Record<string, unknown> = {}) {
  return event("PostModelRequest", session, {
    turn_id: "same-turn",
    model: "test-model",
    status: "completed",
    token_usage: usage,
    ...extra,
  });
}

function usage(input: number, cached: number, output: number) {
  return {
    input_tokens: input, cached_input_tokens: cached, output_tokens: output,
    total_tokens: input + output, reasoning_output_tokens: 0,
  };
}

test("binds separate workspaces by default and counts repeated requests in the same turn", () => {
  const store = new UsageStore(":memory:");
  try {
    store.ingest(event("SessionStart", "first", { source: "startup" }), time);
    store.ingest(event("SessionStart", "second", { source: "startup", cwd: otherWorkspace }), time);
    const first = openFor(store, "first");
    const second = openFor(store, "second", otherWorkspace);
    assert.equal(store.readSession(first, time).status, "waiting");
    store.ingest(request("first", usage(100, 20, 9)), time + 1);
    store.ingest(request("second", usage(400, 0, 5), { cwd: otherWorkspace }), time + 2);
    store.ingest(request("first", usage(100, 20, 9)), time + 3);
    assert.deepEqual(store.readSession(first, time + 4).totals, {
      requests: 2, measuredRequests: 2, inputTokens: 200, cachedInputTokens: 40,
      outputTokens: 18, totalTokens: 218, cacheHitPercent: 20,
    });
    assert.deepEqual(store.readSession(second, time + 4).totals, {
      requests: 1, measuredRequests: 1, inputTokens: 400, cachedInputTokens: 0,
      outputTokens: 5, totalTokens: 405, cacheHitPercent: 0,
    });
  } finally {
    store.close();
  }
});

test("records resumed chats from the first observed request and keeps their workspace binding", () => {
  const store = new UsageStore(":memory:");
  try {
    assert.equal(store.ingest(event("SessionStart", "old", { source: "resume", cwd: otherWorkspace }), time)?.request, false);
    assert.equal(store.ingest(request("old", usage(12, 4, 8), { cwd: otherWorkspace }), time)?.request, true);
    store.ingest(event("SessionStart", "known", { source: "startup" }), time);
    store.ingest(request("known", usage(100, 20, 9)), time);
    assert.equal(store.ingest(event("SessionStart", "known", { source: "startup", cwd: otherWorkspace }), time), undefined);
    assert.equal(store.ingest(request("known", usage(900, 110, 70), { cwd: otherWorkspace }), time), undefined);
    const old = store.readSession(openFor(store, "old", otherWorkspace), time);
    assert.equal(old.totals?.requests, 1);
    assert.equal(old.totals?.partial, true);
    assert.deepEqual(store.readChat("old"), old);
    assert.equal(store.readSession(openFor(store, "known", otherWorkspace), time).status, "unavailable");
    assert.equal(store.readSession(store.openView(time), time).status, "waiting");
    assert.equal(store.readSession("invalid", time).status, "unavailable");
  } finally {
    store.close();
  }
});

test("the next live request enrolls a chat that was already open when collection was updated", () => {
  const store = new UsageStore(":memory:");
  try {
    assert.equal(store.readChat("already-open").status, "waiting");
    assert.equal(store.ingest(request("already-open", usage(21, 6, 4)), time)?.request, true);
    assert.equal(store.ingest(request("already-open", usage(200, 10, 8), { cwd: otherWorkspace }), time + 1), undefined);
    assert.equal(store.readChat("already-open").totals?.requests, 1);
    assert.equal(store.readChat("already-open").totals?.partial, true);
  } finally {
    store.close();
  }
});

test("upgrading an existing database retains request records and can add resumed chats", () => {
  const folder = mkdtempSync(resolve(tmpdir(), "codex-dashboard-upgrade-"));
  const file = resolve(folder, "usage.sqlite");
  try {
    const original = new UsageStore(file);
    try {
      original.ingest(event("SessionStart", "previous", { source: "startup" }), time);
      original.ingest(request("previous", usage(11, 1, 5)), time);
    } finally {
      original.close();
    }
    const beforeUpgrade = new DatabaseSync(file);
    try { beforeUpgrade.exec("ALTER TABLE chats DROP COLUMN partial"); } finally { beforeUpgrade.close(); }

    const upgraded = new UsageStore(file);
    try {
      assert.equal(upgraded.readChat("previous").totals?.totalTokens, 16);
      assert.equal(upgraded.readChat("previous").totals?.partial, undefined);
      upgraded.ingest(request("resumed", usage(40, 10, 5)), time);
      assert.equal(upgraded.readChat("resumed").totals?.partial, true);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("uses partial counts, keeps cancellation and compaction events and excludes payload text", () => {
  const store = new UsageStore(":memory:");
  try {
    store.ingest(event("SessionStart", "test-chat", { source: "startup" }), time);
    const view = openFor(store, "test-chat");
    store.ingest(event("SubagentStart", "test-chat", { agent_id: "child", agent_type: "worker" }), time + 1);
    store.ingest(request("test-chat", usage(8, 2, 1), { agent_id: "child" }), time + 2);
    store.ingest(request("test-chat", null, { status: "cancelled", error: "private reply", transcript_path: "private path" }), time + 3);
    store.ingest(event("PostCompact", "test-chat", { trigger: "manual" }), time + 4);
    store.ingest(event("SubagentStop", "test-chat", { agent_id: "child", last_assistant_message: "private reply" }), time + 5);
    const result = store.readSession(view, time + 6);
    assert.equal(result.totals?.requests, 2);
    assert.equal(result.totals?.measuredRequests, 1);
    assert.equal(result.totals?.cachedInputTokens, 2);
    assert.deepEqual(result.timeline.map((item) => item.kind), [
      "agent-start", "request", "request", "compaction", "agent-stop",
    ]);
    const cancelled = result.timeline[2];
    assert.equal(cancelled.kind, "request");
    assert.equal(cancelled.kind === "request" && cancelled.status, "cancelled");
    assert.equal(cancelled.kind === "request" && cancelled.inputTokens, null);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally {
    store.close();
  }
});

test("binds a valid view only once and only via the dashboard tool", () => {
  const store = new UsageStore(":memory:");
  try {
    store.ingest(event("SessionStart", "first", { source: "startup" }), time);
    store.ingest(event("SessionStart", "second", { source: "startup" }), time);
    store.ingest(request("first", usage(100, 20, 9)), time);
    const view = openFor(store, "first");
    store.ingest(event("PostToolUse", "second", {
      tool_name: "mcp__codex_usage_dashboard__open_usage_dashboard",
      tool_response: { structuredContent: { viewId: view } },
    }), time);
    assert.equal(store.readSession(view, time).totals?.inputTokens, 100);
    const unbound = store.openView(time);
    store.ingest(event("PostToolUse", "first", {
      tool_name: "mcp__other__read_status",
      tool_response: { structuredContent: { viewId: unbound } },
    }), time);
    assert.equal(store.readSession(unbound, time).status, "waiting");
  } finally {
    store.close();
  }
});
