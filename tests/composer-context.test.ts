import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeChatContext } from "../composer/native-usage.ts";
import { readContextHistory, saveContextHistory } from "../composer/context-history.ts";

function withLocalStorage(run: (writes: () => number) => void) {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const values = new Map<string, string>();
  let writes = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        values.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    run(() => writes);
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

test("reads the latest request token count and context window, not cumulative usage", () => {
  const notification = {
    type: "mcp-notification",
    hostId: "local",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "selected-chat",
      tokenUsage: {
        total: { totalTokens: 72_000, inputTokens: 66_000, outputTokens: 6_000 },
        last: { totalTokens: 8_250, inputTokens: 8_000, outputTokens: 250 },
        modelContextWindow: 128_000,
      },
    },
  };

  assert.deepEqual(nativeChatContext(notification, "selected-chat"), {
    usedTokens: 8_250,
    windowTokens: 128_000,
  });
});

test("keeps a valid latest count when capacity is absent and rejects invalid thread data", () => {
  const notification = {
    type: "mcp-notification",
    hostId: "local",
    method: "thread/tokenUsage/updated",
    params: { threadId: "selected-chat", tokenUsage: { last: { totalTokens: 0 } } },
  };

  assert.deepEqual(nativeChatContext(notification, "selected-chat"), { usedTokens: 0, windowTokens: null });
  assert.equal(nativeChatContext(notification, "other-chat"), null);
  assert.equal(nativeChatContext({ ...notification, hostId: "remote" }, "selected-chat"), null);
  assert.equal(nativeChatContext({ ...notification, params: { ...notification.params, tokenUsage: {
    last: { totalTokens: -1 },
  } } }, "selected-chat"), null);
  assert.deepEqual(nativeChatContext({ ...notification, params: { ...notification.params, tokenUsage: {
    last: { totalTokens: 7 }, modelContextWindow: 0,
  } } }, "selected-chat"), { usedTokens: 7, windowTokens: null });
});

test("restores separate per-chat snapshots and skips unchanged writes", () => {
  withLocalStorage((writes) => {
    const firstChat = "a".repeat(64);
    const secondChat = "b".repeat(64);
    const first = { usedTokens: 12_345, windowTokens: 64_000 };
    const second = { usedTokens: 321, windowTokens: null };

    saveContextHistory(firstChat, first);
    saveContextHistory(secondChat, second);
    assert.deepEqual(readContextHistory(firstChat), first);
    assert.deepEqual(readContextHistory(secondChat), second);
    assert.equal(readContextHistory("c".repeat(64)), null);

    const writesBeforeDuplicate = writes();
    saveContextHistory(firstChat, first);
    assert.equal(writes(), writesBeforeDuplicate);
  });
});

test("ignores malformed or invalid snapshots restored from storage", () => {
  withLocalStorage(() => {
    const stored = [
      ["a".repeat(64), { usedTokens: 500, windowTokens: 128_000 }],
      ["b".repeat(64), { usedTokens: -1, windowTokens: 128_000 }],
      ["c".repeat(64), { usedTokens: 500, windowTokens: 0 }],
      ["not-a-chat-hash", { usedTokens: 10, windowTokens: null }],
    ];
    localStorage.setItem("codex-context-dashboard:context:v1", JSON.stringify(stored));

    assert.deepEqual(readContextHistory("a".repeat(64)), { usedTokens: 500, windowTokens: 128_000 });
    assert.equal(readContextHistory("b".repeat(64)), null);
    assert.equal(readContextHistory("c".repeat(64)), null);
    assert.equal(readContextHistory("not-a-chat-hash"), null);
  });
});

test("bounds saved snapshots to the most recent 96 chats", () => {
  withLocalStorage(() => {
    const keys = Array.from({ length: 97 }, (_, index) => index.toString(16).padStart(64, "0"));
    for (const [index, key] of keys.entries()) {
      saveContextHistory(key, { usedTokens: index, windowTokens: 100_000 });
    }

    assert.equal(readContextHistory(keys[0]), null);
    assert.deepEqual(readContextHistory(keys[96]), { usedTokens: 96, windowTokens: 100_000 });
  });
});
