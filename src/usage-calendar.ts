const dayMs = 86_400_000;
const shanghaiOffsetMs = 8 * 3_600_000;

function isoDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcMidnight(date: string) {
  return Date.parse(`${date}T00:00:00Z`);
}

export function beijingDate(timestamp: number) {
  return isoDay(timestamp + shanghaiOffsetMs);
}

export function beijingMidnight(date: string) {
  return utcMidnight(date) - shanghaiOffsetMs;
}

export function calendarDate(year: number, month = 1, day = 1) {
  return isoDay(Date.UTC(year, month - 1, day));
}

export function addDays(date: string, days: number) {
  return isoDay(utcMidnight(date) + days * dayMs);
}

export function mondayOf(date: string) {
  const dayOfWeek = new Date(utcMidnight(date)).getUTCDay();
  return addDays(date, -((dayOfWeek + 6) % 7));
}
