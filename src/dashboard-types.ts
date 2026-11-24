export type Availability = "ready" | "stale" | "unavailable";

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  durationMinutes: number | null;
  resetsAt: number | null;
}

export interface AccountSnapshot {
  quota: {
    status: Availability;
    updatedAt: number | null;
    windows: QuotaWindow[];
  };
  usage: {
    status: Availability;
    updatedAt: number | null;
    days: { date: string; tokens: number }[];
  };
}

export interface SessionTotals {
  partial?: true;
  requests: number;
  measuredRequests: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheHitPercent: number | null;
}

export interface UsageTokenAmounts {
  totalTokens: number | null;
  uncachedInputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface DailyModelUsage extends UsageTokenAmounts {
  date: string;
  model: string | null;
}

export interface UsageStatistics {
  year: number;
  today: string;
  firstDate: string | null;
  totals: {
    today: number | null;
    week: number | null;
    month: number | null;
    all: number | null;
  };
  days: DailyModelUsage[];
}

export type RequestStatus = "completed" | "failed" | "cancelled";

export type TimelineItem =
  | {
      kind: "request";
      timestamp: number;
      model: string | null;
      status: RequestStatus;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      agentId: string | null;
    }
  | {
      kind: "compaction";
      timestamp: number;
      trigger: "manual" | "auto" | null;
    }
  | {
      kind: "agent-start" | "agent-stop";
      timestamp: number;
      agentId: string;
      agentType: string | null;
    };

export interface DashboardSnapshot {
  session: {
    status: "waiting" | "ready" | "unavailable";
    totals: SessionTotals | null;
    timeline: TimelineItem[];
  };
  account: AccountSnapshot;
}
