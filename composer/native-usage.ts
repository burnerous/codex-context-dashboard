export interface NativeChatUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitPercent: number | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function nativeChatUsage(message: unknown, activeId: string | null): NativeChatUsage | null {
  const envelope = record(message);
  if (!activeId || envelope?.type !== "mcp-notification" || envelope.hostId !== "local"
    || envelope.method !== "thread/tokenUsage/updated") return null;
  const params = record(envelope.params);
  if (params?.threadId !== activeId) return null;
  const total = record(record(params.tokenUsage)?.total);
  const totalTokens = tokenCount(total?.totalTokens);
  const inputTokens = tokenCount(total?.inputTokens);
  const outputTokens = tokenCount(total?.outputTokens);
  if (totalTokens === null || inputTokens === null || outputTokens === null) return null;
  const cached = tokenCount(total?.cachedInputTokens);
  const cacheHitPercent = inputTokens > 0 && cached !== null && cached <= inputTokens ? 100 * cached / inputTokens : null;
  return { totalTokens, inputTokens, outputTokens, cacheHitPercent };
}
