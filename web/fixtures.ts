import type { DashboardSnapshot, TimelineItem } from "../src/dashboard-types.js";

export const demoEmpty: DashboardSnapshot = {
  session: { status: "waiting", totals: null, timeline: [] },
  account: {
    quota: { status: "unavailable", updatedAt: null, windows: [] },
    usage: { status: "unavailable", updatedAt: null, days: [] },
  },
};

export function readyDemo(now: number): DashboardSnapshot {
  const minute = 60_000;
  const beijing = new Date(now + 8 * 60 * minute).toISOString().slice(0, 10);
  const currentDay = Date.parse(`${beijing}T00:00:00Z`);
  const days = [1_535_100, 2_618_239, null, 979_080, 2_137_619, 3_390_804, 2_421_007]
    .flatMap((tokens, index) => tokens === null ? [] : [{
      date: new Date(currentDay - (6 - index) * 86_400_000).toISOString().slice(0, 10),
      tokens,
    }]);

  const start = now - 91 * minute;
  const model = "gpt-6.2-sol";
  const agents = { review: "demo/review", data: "demo/data" };
  const requests = [
    [63_489, 8_309, 34_816], [95_903, 11_387, 56_320], [112_464, 13_429, 80_896],
    [134_642, 7_280, 85_504], [162_701, 21_329, 129_880], [182_967, 15_141, 145_408],
    [209_024, 12_642, 157_440], [48_847, 17_519, 28_672], [57_119, 12_680, 37_888],
    null, [99_272, 9_471, 55_296], [131_437, 17_911, 80_896],
    [154_120, 13_913, 98_304], [169_284, 7_804, 122_880], [72_184, 6_920, 44_032],
    [92_327, 9_108, 61_440],
  ];

  const timeline: TimelineItem[] = requests.map((usage, index) => ({
    kind: "request",
    timestamp: start + index * 6 * minute,
    model: model,
    status: usage ? "completed" : "failed",
    inputTokens: usage?.[0] ?? null,
    outputTokens: usage?.[1] ?? null,
    cachedInputTokens: usage?.[2] ?? null,
    agentId: index === 8 || index === 10 ? agents.review : index === 15 ? agents.data : null,
  }));
  timeline.push(
    { kind: "compaction", trigger: "auto", timestamp: start + 39 * minute },
    { kind: "agent-start", agentId: agents.review, agentType: "explorer", timestamp: start + 46 * minute },
    { kind: "agent-stop", agentId: agents.review, agentType: "explorer", timestamp: start + 66 * minute },
    { kind: "compaction", trigger: "manual", timestamp: start + 81 * minute },
    { kind: "agent-start", agentId: agents.data, agentType: "worker", timestamp: start + 87 * minute },
  );
  timeline.sort((a, b) => a.timestamp - b.timestamp);

  const totals = requests.reduce((sum, usage) => {
    if (usage) {
      sum.inputTokens += usage[0];
      sum.outputTokens += usage[1];
      sum.cachedInputTokens += usage[2];
      sum.measuredRequests++;
    }
    return sum;
  }, { measuredRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

  return {
    session: {
      status: "ready",
      timeline,
      totals: {
        ...totals,
        requests: requests.length,
        totalTokens: totals.inputTokens + totals.outputTokens,
        cacheHitPercent: 100 * totals.cachedInputTokens / totals.inputTokens,
      },
    },
    account: {
      quota: {
        status: "ready",
        updatedAt: now,
        windows: [
          { id: "primary", label: "5 小时额度", usedPercent: 67, durationMinutes: 300, resetsAt: now + 68 * minute },
          { id: "secondary", label: "每周额度", usedPercent: 34, durationMinutes: 10080, resetsAt: now + 4034 * minute },
        ],
      },
      usage: { status: "stale", updatedAt: now - 107 * minute, days },
    },
  };
}
