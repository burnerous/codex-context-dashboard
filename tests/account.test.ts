import assert from "node:assert/strict";
import test from "node:test";
import { AccountService } from "../src/account.ts";

const firstReadAt = 1_794_956_400_000;

const quota = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_794_974_400 },
    secondary: { usedPercent: 63, windowDurationMins: 10_080, resetsAt: null },
  },
  rateLimitsByLimitId: null,
};

const usage = {
  summary: {
    lifetimeTokens: 40_000,
    peakDailyTokens: 18_000,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
  },
  dailyUsageBuckets: [
    { startDate: "2026-11-18", tokens: 18_000 },
    { startDate: "2026-11-11", tokens: 12_000 },
    { startDate: "2026-11-15", tokens: 0 },
    { startDate: "2026-11-12", tokens: 1_500 },
    { startDate: "2026-11-13", tokens: -1 },
    { startDate: "2026-11-31", tokens: 250 },
  ],
};

test("uses returned quota percentages and durations and converts reset seconds to milliseconds", async () => {
  const service = new AccountService({
    now: () => firstReadAt,
    read: async (method) => method === "account/rateLimits/read" ? quota : usage,
  });

  const result = await service.snapshot();
  assert.deepEqual(result.quota, {
    status: "ready",
    updatedAt: firstReadAt,
    windows: [
      {
        id: "primary",
        label: "5 小时",
        usedPercent: 0,
        durationMinutes: 300,
        resetsAt: 1_794_974_400_000,
      },
      {
        id: "secondary",
        label: "每周",
        usedPercent: 63,
        durationMinutes: 10_080,
        resetsAt: null,
      },
    ],
  });
});

test("falls back to the Codex bucket when the direct quota has no windows", async () => {
  const service = new AccountService({
    read: async (method) => method === "account/rateLimits/read"
      ? {
        rateLimits: { limitId: "codex", primary: null, secondary: null },
        rateLimitsByLimitId: {
          codex_other: quota.rateLimits,
          codex: {
            primary: null,
            secondary: { usedPercent: 8, windowDurationMins: null, resetsAt: null },
          },
        },
      }
      : usage,
  });

  const result = await service.snapshot();
  assert.deepEqual(result.quota.windows, [{
    id: "secondary",
    label: "次要额度",
    usedPercent: 8,
    durationMinutes: null,
    resetsAt: null,
  }]);
});

test("keeps the reported dates in the newest seven service days and preserves explicit zero usage", async () => {
  const service = new AccountService({
    now: () => firstReadAt,
    read: async (method) => method === "account/rateLimits/read" ? quota : usage,
  });

  const result = await service.snapshot();
  assert.deepEqual(result.usage, {
    status: "ready",
    updatedAt: firstReadAt,
    days: [
      { date: "2026-11-12", tokens: 1_500 },
      { date: "2026-11-15", tokens: 0 },
      { date: "2026-11-18", tokens: 18_000 },
    ],
  });
});

test("a failed quota read leaves the usage read available", async () => {
  const service = new AccountService({
    read: async (method) => {
      if (method === "account/rateLimits/read") throw new Error("quota read failed");
      return usage;
    },
  });

  const result = await service.snapshot();
  assert.deepEqual(result.quota, { status: "unavailable", updatedAt: null, windows: [] });
  assert.equal(result.usage.status, "ready");
  assert.equal(result.usage.days.at(-1)?.tokens, 18_000);
});

test("missing daily buckets leave usage unavailable without hiding quota", async () => {
  const service = new AccountService({
    read: async (method) => method === "account/rateLimits/read"
      ? quota
      : { ...usage, dailyUsageBuckets: null },
  });

  const result = await service.snapshot();
  assert.deepEqual(result.usage, { status: "unavailable", updatedAt: null, days: [] });
  assert.equal(result.quota.status, "ready");
});

test("concurrent and recent requests share a fetch and a failed refresh keeps the previous timestamp", async () => {
  let now = firstReadAt;
  let quotaFailed = false;
  let quotaReads = 0;
  let usageReads = 0;
  const service = new AccountService({
    now: () => now,
    read: async (method) => {
      if (method === "account/rateLimits/read") {
        quotaReads++;
        if (quotaFailed) throw new Error("quota read failed");
        return quota;
      }
      usageReads++;
      return usage;
    },
  });

  const [initial, concurrent] = await Promise.all([service.snapshot(), service.snapshot()]);
  now += 59_999;
  assert.deepEqual(concurrent, initial);
  assert.deepEqual(await service.snapshot(), initial);
  assert.equal(quotaReads, 1);
  assert.equal(usageReads, 1);

  now++;
  quotaFailed = true;
  const refreshed = await service.snapshot();
  assert.deepEqual(refreshed.quota, { ...initial.quota, status: "stale" });
  assert.equal(refreshed.usage.status, "ready");
  assert.equal(refreshed.usage.updatedAt, now);
  assert.equal(quotaReads, 2);
  assert.equal(usageReads, 2);

  quotaFailed = false;
  now += 60_000;
  const recovered = await service.snapshot();
  assert.equal(recovered.quota.status, "ready");
  assert.equal(recovered.quota.updatedAt, now);
});
