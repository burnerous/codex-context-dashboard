import type { AccountSnapshot, QuotaWindow } from "./dashboard-types.ts";

export const QUOTA_METHOD = "account/rateLimits/read";
export const USAGE_METHOD = "account/usage/read";
export type AccountReadMethod = typeof QUOTA_METHOD | typeof USAGE_METHOD;

const dayMs = 86_400_000;
type WindowKey = "primary" | "secondary";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function windowLabel(key: WindowKey, minutes: number | null): string {
  if (minutes === null) return key === "primary" ? "主要额度" : "次要额度";
  if (minutes === 10_080) return "每周";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function parseQuotaWindow(key: WindowKey, value: unknown): QuotaWindow | null {
  const window = asRecord(value);
  const percent = window?.usedPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;

  const duration = window?.windowDurationMins;
  const durationMinutes = typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0
    ? duration
    : null;
  // The App Server reports Unix seconds. The dashboard uses milliseconds.
  const resetSeconds = window?.resetsAt;
  const resetsAt = typeof resetSeconds === "number" && Number.isSafeInteger(resetSeconds)
    && resetSeconds >= 0 && resetSeconds <= 8_640_000_000_000
    ? resetSeconds * 1000
    : null;
  return { id: key, label: windowLabel(key, durationMinutes), usedPercent: percent, durationMinutes, resetsAt };
}

function quotaWindows(value: unknown): QuotaWindow[] {
  const response = asRecord(value);
  const direct = asRecord(response?.rateLimits);
  const byId = asRecord(response?.rateLimitsByLimitId);
  const sameBucket = typeof direct?.limitId === "string" ? byId?.[direct.limitId] : undefined;
  const keyed = Object.values(byId ?? {});
  for (const candidate of [direct, byId?.codex, sameBucket, keyed.length === 1 ? keyed[0] : undefined]) {
    const bucket = asRecord(candidate);
    const windows = [
      parseQuotaWindow("primary", bucket?.primary),
      parseQuotaWindow("secondary", bucket?.secondary),
    ].filter((window) => window !== null);
    if (windows.length > 0) return windows;
  }
  return [];
}

function usageDays(value: unknown): AccountSnapshot["usage"]["days"] {
  const buckets = asRecord(value)?.dailyUsageBuckets;
  if (!Array.isArray(buckets)) return [];

  const byDate = new Map<string, { date: string; tokens: number; time: number }>();
  for (const value of buckets) {
    const bucket = asRecord(value);
    const date = bucket?.startDate;
    const tokens = bucket?.tokens;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) continue;

    const time = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) continue;
    byDate.set(date, { date, tokens, time });
  }

  const days = [...byDate.values()].sort((a, b) => a.time - b.time);
  const latest = days.at(-1);
  if (!latest) return [];
  const start = latest.time - 6 * dayMs;
  return days.filter(({ time }) => time >= start).map(({ date, tokens }) => ({ date, tokens }));
}

export function parseAccountSnapshot(
  quota: unknown, usage: unknown, updatedAt: number, previous?: AccountSnapshot,
): AccountSnapshot {
  const windows = quotaWindows(quota);
  const days = usageDays(usage);
  return {
    quota: windows.length ? { status: "ready", updatedAt, windows } : {
      status: previous?.quota.updatedAt != null ? "stale" : "unavailable",
      updatedAt: previous?.quota.updatedAt ?? null,
      windows: previous?.quota.windows ?? [],
    },
    usage: days.length ? { status: "ready", updatedAt, days } : {
      status: previous?.usage.updatedAt != null ? "stale" : "unavailable",
      updatedAt: previous?.usage.updatedAt ?? null,
      days: previous?.usage.days ?? [],
    },
  };
}

export function keepLatestAccount(snapshot: AccountSnapshot, previous?: AccountSnapshot | null): AccountSnapshot {
  if (!previous) return snapshot;
  const latest = <T extends { updatedAt: number | null }>(next: T, last: T) =>
    (last.updatedAt ?? -1) > (next.updatedAt ?? -1) ? last : next;
  return {
    quota: latest(snapshot.quota, previous.quota),
    usage: latest(snapshot.usage, previous.usage),
  };
}
