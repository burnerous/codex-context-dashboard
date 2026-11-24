import type { DailyModelUsage, UsageStatistics, UsageTokenAmounts } from "../src/dashboard-types.ts";
import { addDays, calendarDate, mondayOf } from "../src/usage-calendar.ts";

export type UsageGrain = "day" | "week" | "month";

export interface ModelUsage extends UsageTokenAmounts {
  model: string | null;
}

export interface UsagePeriod {
  start: string;
  end: string;
  tokens: number | null;
  models: ModelUsage[];
}

const amountKeys = ["totalTokens", "uncachedInputTokens", "cachedInputTokens", "outputTokens"] as const;
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const integers = new Intl.NumberFormat("zh-CN");

export function tokenNumber(value: number | null, shorten = false) {
  return value === null ? "—" : (shorten ? compact : integers).format(value);
}

export function modelLabel(model: string | null) {
  return model ?? "未知模型";
}

export function sumKnown(values: Iterable<number | null>) {
  let sum: number | null = null;
  for (const value of values) if (value !== null) sum = (sum ?? 0) + value;
  return sum;
}

export function aggregateModels(records: readonly ModelUsage[]) {
  const groups = new Map<string | null, ModelUsage>();
  for (const record of records) {
    const previous = groups.get(record.model);
    if (previous) {
      for (const key of amountKeys) {
        if (record[key] !== null) previous[key] = (previous[key] ?? 0) + record[key];
      }
    } else {
      groups.set(record.model, {
        model: record.model, totalTokens: record.totalTokens, uncachedInputTokens: record.uncachedInputTokens,
        cachedInputTokens: record.cachedInputTokens, outputTokens: record.outputTokens,
      });
    }
  }
  return [...groups.values()].sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1)
    || modelLabel(a.model).localeCompare(modelLabel(b.model)));
}

function periodKey(date: string, grain: UsageGrain) {
  if (grain === "week") return mondayOf(date);
  return grain === "month" ? `${date.slice(0, 7)}-01` : date;
}

export function usagePeriods(snapshot: UsageStatistics, grain: UsageGrain, month?: number): UsagePeriod[] {
  const start = calendarDate(snapshot.year, month ?? 1);
  const end = month === undefined ? calendarDate(snapshot.year + 1) : calendarDate(snapshot.year, month + 1);
  const records = new Map<string, DailyModelUsage[]>();
  for (const row of snapshot.days) {
    if (row.date < start || row.date >= end) continue;
    const key = periodKey(row.date, grain);
    const group = records.get(key);
    if (group) group.push(row);
    else records.set(key, [row]);
  }
  const periods: UsagePeriod[] = [];
  for (let key = periodKey(start, grain); key < end;) {
    const next = grain === "month" ? calendarDate(snapshot.year, Number(key.slice(5, 7)) + 1)
      : addDays(key, grain === "week" ? 7 : 1);
    const periodStart = key < start ? start : key;
    const periodEnd = next > end ? end : next;
    const group = records.get(key) ?? [];
    const models = aggregateModels(group);
    const covered = snapshot.firstDate !== null && periodEnd > snapshot.firstDate && periodStart <= snapshot.today;
    periods.push({
      start: periodStart, end: periodEnd, models,
      tokens: models.length ? sumKnown(models.map((model) => model.totalTokens)) : covered ? 0 : null,
    });
    key = next;
  }
  return periods;
}

export function periodLabel(period: UsagePeriod) {
  const last = addDays(period.end, -1);
  return last === period.start ? period.start : `${period.start} – ${last}`;
}
