import { sampleLimit, type SpeedHistory, type SpeedSample } from "./speed.ts";

const storageKey = "codex-context-dashboard:speed:v1";
export const speedHistoryLimit = 96;
const chatKeyPattern = /^[a-f0-9]{64}$/;
type Entry = [string, SpeedHistory];

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSample(value: unknown): value is SpeedSample {
  if (typeof value !== "object" || !value) return false;
  const sample = value as Partial<SpeedSample>;
  return nonnegative(sample.at) && nonnegative(sample.rate) && nonnegative(sample.segment)
    && Number.isSafeInteger(sample.segment);
}

function isHistory(value: unknown): value is SpeedHistory {
  if (typeof value !== "object" || !value) return false;
  const history = value as Partial<SpeedHistory>;
  return nonnegative(history.activeMs) && history.activeMs > 0 && nonnegative(history.tokens)
    && nonnegative(history.peak) && Array.isArray(history.samples)
    && history.samples.length > 0 && history.samples.length <= sampleLimit && history.samples.every(isSample);
}

function savedEntries(): Entry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.slice(-speedHistoryLimit).filter((entry): entry is Entry => Array.isArray(entry)
      && typeof entry[0] === "string" && chatKeyPattern.test(entry[0]) && isHistory(entry[1]));
  } catch {
    return [];
  }
}

export function readSpeedHistory(chatKey: string) {
  return savedEntries().find(([key]) => key === chatKey)?.[1];
}

export function isNewerSpeedHistory(history: SpeedHistory, previous?: SpeedHistory | null) {
  return !previous || history.activeMs > previous.activeMs
    || history.activeMs === previous.activeMs && history.tokens > previous.tokens;
}

export function saveSpeedHistory(chatKey: string, history: SpeedHistory) {
  if (!chatKeyPattern.test(chatKey)) return;
  const write = () => {
    try {
      const entries = savedEntries();
      const stored = entries.find(([key]) => key === chatKey)?.[1];
      if (!isNewerSpeedHistory(history, stored)) return;
      const recent = entries.filter(([key]) => key !== chatKey).slice(-(speedHistoryLimit - 1));
      recent.push([chatKey, history]);
      localStorage.setItem(storageKey, JSON.stringify(recent));
    } catch {
      // Live measurement still works when the renderer cannot write local storage.
    }
  };
  if (navigator.locks) void navigator.locks.request(storageKey, write).catch(write);
  else write();
}
