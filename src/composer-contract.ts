import type { AccountSnapshot, SessionTotals } from "./dashboard-types.ts";

export const previewSelector = "[data-codex-usage-preview]";
export const accountProperty = "--cup-account-snapshot";
export const chatProperty = "--cup-chat-snapshot";
export const dashboardServerName = "codex_usage_dashboard";

export function chatDetailsUri(threadId: string) {
  return `codex-usage://dashboard/chat/${threadId}`;
}

export function usageStatisticsUri(year: number | "{year}", target = "local") {
  return `codex-usage://dashboard/statistics/${year}/${target}`;
}

const localSidebarId = /^local:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
export const localChatId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function sessionIdFromSidebar(rowId: string | null): string | null {
  if (!rowId) return null;
  // The Codex desktop sidebar wraps local UUIDs in a prefix that the hook does not send.
  const local = localSidebarId.exec(rowId);
  return local ? local[1].toLowerCase() : rowId;
}

export function encodeSnapshot(summary: AccountSnapshot | SessionTotals) {
  return `"${encodeURIComponent(JSON.stringify(summary))}"`;
}

export function decodeSnapshot<T>(raw: string): T | null {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  try {
    return JSON.parse(decodeURIComponent(raw.slice(1, -1))) as T;
  } catch {
    return null;
  }
}
