import type { NativeChatContext } from "./native-usage.ts";

const storageKey = "codex-context-dashboard:context:v1";
const historyLimit = 96;
const chatKeyPattern = /^[a-f0-9]{64}$/;
type Entry = [string, NativeChatContext];

function isContext(value: unknown): value is NativeChatContext {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Partial<NativeChatContext>;
  const validUsed = typeof context.usedTokens === "number"
    && Number.isSafeInteger(context.usedTokens) && context.usedTokens >= 0;
  const validWindow = context.windowTokens === null
    || typeof context.windowTokens === "number"
      && Number.isSafeInteger(context.windowTokens) && context.windowTokens > 0;
  return validUsed && validWindow;
}

function savedEntries(): Entry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((entry): entry is Entry => Array.isArray(entry)
      && typeof entry[0] === "string" && chatKeyPattern.test(entry[0]) && isContext(entry[1]))
      .slice(-historyLimit);
  } catch {
    return [];
  }
}

export function readContextHistory(chatKey: string): NativeChatContext | null {
  if (!chatKeyPattern.test(chatKey)) return null;
  return savedEntries().find(([key]) => key === chatKey)?.[1] ?? null;
}

export function saveContextHistory(chatKey: string, snapshot: NativeChatContext): void {
  if (!chatKeyPattern.test(chatKey) || !isContext(snapshot)) return;

  const write = () => {
    try {
      const entries = savedEntries();
      const stored = entries.find(([key]) => key === chatKey)?.[1];
      if (stored?.usedTokens === snapshot.usedTokens && stored.windowTokens === snapshot.windowTokens) return;
      const recent = entries.filter(([key]) => key !== chatKey).slice(-(historyLimit - 1));
      recent.push([chatKey, snapshot]);
      localStorage.setItem(storageKey, JSON.stringify(recent));
    } catch {
      // Live context can still be shown if the renderer cannot write local storage.
    }
  };

  if (typeof navigator !== "undefined" && navigator.locks) {
    void navigator.locks.request(storageKey, write).catch(write);
  } else {
    write();
  }
}
