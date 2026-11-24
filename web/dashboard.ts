import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { AccountSnapshot, DashboardSnapshot, SessionTotals, TimelineItem } from "../src/dashboard-types.js";
import { requestStatuses, timelineLabel } from "../src/timeline-labels.ts";
import { demoEmpty, readyDemo } from "./fixtures.js";

type DemoState = "ready" | "empty" | "error";
type RequestEntry = { item: Extract<TimelineItem, { kind: "request" }>; number: number };
type TimelineEntry = { item: TimelineItem; number: number };

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const ui = {
  root: element("dashboard"),
  notice: element("notice"),
  noticeText: element("notice-text"),
  timestamp: element("updated-at"),
  refresh: element<HTMLButtonElement>("refresh"),
  snapshot: element("snapshot"),
  quotaState: element("quota-state"),
  quotaRows: element("quota-rows"),
  dailyState: element("daily-state"),
  dailyChart: element("daily-chart"),
  dailyDetail: element("daily-detail"),
  sessionState: element("session-state"),
  sessionFigures: element("session-figures"),
  activity: element("activity"),
  requestRange: element("request-range"),
  rangeLabel: element("range-label"),
  older: document.querySelector<HTMLButtonElement>('[data-action="older"]')!,
  newer: document.querySelector<HTMLButtonElement>('[data-action="newer"]')!,
  missingLegend: element("missing-legend"),
  requestChart: element("request-chart"),
  requestDetail: element("request-detail"),
  events: element("events"),
  moreEvents: element<HTMLButtonElement>("more-events"),
  demoControls: element("demo-controls"),
  demoState: element<HTMLSelectElement>("demo-state"),
  demoTheme: element<HTMLSelectElement>("demo-theme"),
};

const whole = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const timeZone = "Asia/Shanghai";
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const monthDay = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" });
const longDate = new Intl.DateTimeFormat("zh-CN", { timeZone, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
const dayMilliseconds = 86_400_000;
const pageSize = 10;
const defaultEventLimit = 4;

let currentDay: string | null = null;
let currentRequest: number | null = null;
let requestPage = 0;
let eventFilter: "key" | "all" = "key";
let eventLimit = defaultEventLimit;
let chronology: TimelineEntry[] = [];
let requests: RequestEntry[] = [];
let visibleRequests: RequestEntry[] = [];
let days = new Map<string, number>();
let snapshotSignature: string | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function knownNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timeLabel(timestamp: number): string {
  return `${monthDay.format(timestamp)} ${clock.format(timestamp)}`;
}

function displayNumber(value: number | null | undefined): string {
  return knownNumber(value) ? whole.format(value) : "—";
}

function magnitude(value: number | null | undefined): { number: string; unit: string } {
  if (!knownNumber(value)) return { number: "—", unit: "" };
  if (value >= 100_000_000) return { number: decimal.format(value / 100_000_000), unit: "亿" };
  if (value >= 10_000) return { number: decimal.format(value / 10_000), unit: "万" };
  return { number: whole.format(value), unit: "" };
}

function compactNumber(value: number | null | undefined): string {
  const { number, unit } = magnitude(value);
  return `${number}${unit}`;
}

function box(message: string): string {
  return `<div class="empty-box">${escapeHtml(message)}</div>`;
}

function setSourceStatus(node: HTMLElement, source: { status: string; updatedAt: number | null }): void {
  node.hidden = source.status !== "stale";
  node.textContent = source.status === "stale"
    ? `上次记录${knownNumber(source.updatedAt) ? ` ${timeLabel(source.updatedAt)}` : ""}`
    : "";
  node.dataset.kind = source.status;
  node.title = knownNumber(source.updatedAt) ? `更新于 ${longDate.format(source.updatedAt)}，北京时间` : "";
}

function renderQuota(quota: AccountSnapshot["quota"]): void {
  setSourceStatus(ui.quotaState, quota);
  if (quota.status === "unavailable" || quota.windows.length === 0) {
    ui.quotaRows.innerHTML = box("暂无账号额度");
    return;
  }

  ui.quotaRows.innerHTML = quota.windows.map(({ label, usedPercent, resetsAt, durationMinutes }) => {
    const name = durationMinutes === 300 ? "5 小时额度" : durationMinutes === 10080 ? "每周额度" : label || "额度";
    const value = knownNumber(usedPercent) ? Math.min(100, usedPercent) : null;
    const used = value === null ? "—" : `${decimal.format(value)}%`;
    const remaining = value === null ? "—" : `${decimal.format(100 - value)}%`;
    const reset = knownNumber(resetsAt) ? `重置 ${timeLabel(resetsAt)}` : "重置时间未知";
    return `<div class="quota-row">
      <div class="quota-meta">
        <strong>${escapeHtml(name)}</strong>
        <span class="reset-time numeric">${reset}</span>
      </div>
      <div class="quota-figures">
        <span><span class="numeric">${used}</span>已用</span>
        <span class="remaining"><span class="numeric">${remaining}</span>剩余</span>
      </div>
      <div class="quota-track" aria-hidden="true" style="--used:${value ?? 0}%" ${value !== null && value >= 85 ? "data-high" : ""}></div>
    </div>`;
  }).join("");
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function dateRange(ending: string): string[] {
  const lastMidnight = Date.parse(`${ending}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => new Date(lastMidnight - (6 - index) * dayMilliseconds).toISOString().slice(0, 10));
}

function dateShort(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function showDay(date: string): void {
  for (const day of ui.dailyChart.querySelectorAll<HTMLButtonElement>("[data-day]")) {
    day.setAttribute("aria-pressed", String(day.dataset.day === date));
  }
  const count = days.get(date);
  ui.dailyDetail.hidden = false;
  ui.dailyDetail.innerHTML = `<span class="numeric">${dateShort(date)}</span><strong>${
    count === undefined ? "暂无记录" : `<span class="numeric">${displayNumber(count)}</span> Token`
  }</strong>`;
}

function renderDaily(usage: AccountSnapshot["usage"]): void {
  setSourceStatus(ui.dailyState, usage);
  days = new Map(usage.days.filter(({ date, tokens }) => isDate(date) && knownNumber(tokens)).map(({ date, tokens }) => [date, tokens]));
  const newest = [...days.keys()].sort().at(-1);
  if (usage.status === "unavailable" || !newest) {
    ui.dailyChart.innerHTML = box("暂无每日用量");
    ui.dailyDetail.hidden = true;
    return;
  }

  const dates = dateRange(newest);
  const peak = Math.max(1, ...dates.map((date) => days.get(date) ?? 0));
  ui.dailyChart.innerHTML = `<div class="day-bars" role="group" aria-label="逐日 Token 用量">
    ${dates.map((date) => {
      const count = days.get(date);
      const description = count === undefined ? "暂无记录" : `${displayNumber(count)} Token`;
      return `<button type="button" class="day-button" data-day="${date}" data-focus-key="${date}"
        aria-pressed="false" aria-label="${date}，${description}" title="${date} · ${description}">
        <span class="day-track" aria-hidden="true"><span class="day-fill" style="--day-level:${(count ?? 0) / peak * 100}%"
          ${count === undefined ? "data-missing" : count === 0 ? "data-zero" : ""}></span></span>
        <span class="numeric" aria-hidden="true">${dateShort(date)}</span>
      </button>`;
    }).join("")}
  </div>`;
  showDay(currentDay && dates.includes(currentDay) ? currentDay : newest);
}

function stat(label: string, value: { number: string; unit: string }, exact: string, secondary = ""): string {
  return `<div class="stat">
    <dt>${label}</dt>
    <dd title="${exact}" aria-label="${exact}"><span class="value">${value.number}</span><span class="value-unit">${value.unit}</span></dd>
    ${secondary}
  </div>`;
}

function renderTotals(totals: SessionTotals | null): void {
  const { requests: count, measuredRequests, inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheHitPercent } = totals ?? {};
  const incomplete = count !== undefined && measuredRequests !== undefined && measuredRequests < count;
  const coverage = incomplete ? `已统计 ${measuredRequests}/${count} 次请求` : totals?.partial ? "从开始采集后统计" : "";
  const cache = knownNumber(cacheHitPercent) ? `${decimal.format(cacheHitPercent)}%` : "—";
  const cached = knownNumber(cachedInputTokens)
    ? `<small title="缓存输入 ${displayNumber(cachedInputTokens)} Token">缓存输入 <span class="numeric">${compactNumber(cachedInputTokens)}</span></small>`
    : "";
  ui.sessionState.textContent = coverage;
  ui.sessionState.hidden = !coverage;
  ui.sessionFigures.innerHTML = `<dl class="stats-grid">
    ${stat(totals?.partial ? "已记录 Token" : "累计 Token", magnitude(totalTokens), displayNumber(totalTokens))}
    ${stat("已记录请求", { number: displayNumber(count), unit: "" }, displayNumber(count))}
    ${stat("输入 Token", magnitude(inputTokens), displayNumber(inputTokens))}
    ${stat("输出 Token", magnitude(outputTokens), displayNumber(outputTokens))}
    ${stat("缓存命中率", { number: cache, unit: "" }, cache, cached)}
  </dl>`;
}

function requestDescription({ item, number }: RequestEntry): string {
  return `第 ${number} 次请求，${requestStatuses[item.status]}，输入 ${displayNumber(item.inputTokens)}，输出 ${displayNumber(item.outputTokens)}，缓存输入 ${displayNumber(item.cachedInputTokens)}`;
}

function showRequest(entry: RequestEntry): void {
  for (const point of ui.requestChart.querySelectorAll<HTMLButtonElement>("[data-request]")) {
    point.setAttribute("aria-pressed", String(Number(point.dataset.request) === entry.number));
  }
  const { number, item } = entry;
  const status = item.status === "completed" ? "" : `<span class="error-text">${requestStatuses[item.status]}</span>`;
  ui.requestDetail.hidden = false;
  ui.requestDetail.innerHTML = `<div class="request-detail-head">
    <strong>第 <span class="numeric">${number}</span> 次</strong>
    <span class="numeric" title="${longDate.format(item.timestamp)}">${clock.format(item.timestamp)}</span>
    ${item.model ? `<span class="model-name">${escapeHtml(item.model)}</span>` : ""}
    ${status}
  </div>
  <div class="request-detail-values">
    <span>输入 <span class="numeric">${displayNumber(item.inputTokens)}</span></span>
    <span>输出 <span class="numeric">${displayNumber(item.outputTokens)}</span></span>
    <span>缓存输入 <span class="numeric">${displayNumber(item.cachedInputTokens)}</span></span>
  </div>`;
}

function yLimit(peak: number): number {
  const order = 10 ** Math.floor(Math.log10(Math.max(peak, 2)));
  return order * ([1, 2, 5, 10].find((step) => step * order >= peak) ?? 10);
}

function pointsForChart(entries: RequestEntry[], limit: number): string {
  return entries.map((entry, index) => {
    const { item, number } = entry;
    const input = item.inputTokens ?? 0;
    const output = item.outputTokens ?? 0;
    const sum = input + output;
    const incomplete = item.inputTokens === null || item.outputTokens === null;
    const description = requestDescription(entry);
    const mark = index === 0 || index === entries.length - 1 || (index % 4 === 0 && index < entries.length - 2);
    const height = Math.min(100, Math.max(2, sum / limit * 100));
    const measured = sum > 0 ? `<span class="point-stack" style="height:${height}%">
      <span class="point-segment point-output" style="height:${100 * output / sum}%"></span>
      <span class="point-segment point-input" style="height:${100 * input / sum}%"></span>
    </span>` : "";
    const glyph = incomplete || sum === 0 ? `<span class="point-glyph"
      ${incomplete ? "" : "data-zero"} ${item.status === "failed" ? "data-failed" : ""}></span>` : "";
    return `<button type="button" class="point" data-request="${number}" data-focus-key="request-${number}"
      aria-pressed="false" aria-label="${description}" title="${description}">
      <span class="point-track" aria-hidden="true">${measured}${glyph}</span>
      <span class="point-index numeric" aria-hidden="true">${mark ? number : ""}</span>
    </button>`;
  }).join("");
}

function renderTrend(): void {
  const count = requests.length;
  ui.requestRange.hidden = count <= pageSize;
  ui.requestDetail.hidden = true;
  ui.missingLegend.hidden = true;
  if (!count) {
    visibleRequests = [];
    ui.requestChart.innerHTML = box("暂无请求记录");
    return;
  }

  requestPage = Math.min(requestPage, Math.ceil(count / pageSize) - 1);
  const end = count - requestPage * pageSize;
  const start = Math.max(0, end - pageSize);
  visibleRequests = requests.slice(start, end);
  ui.rangeLabel.textContent = `${start + 1}–${end} / ${count}`;
  ui.older.disabled = start === 0;
  ui.newer.disabled = end === count;
  ui.missingLegend.hidden = !visibleRequests.some(({ item }) => item.inputTokens === null || item.outputTokens === null);

  const peak = requests.reduce((largest, { item }) => Math.max(largest, (item.inputTokens ?? 0) + (item.outputTokens ?? 0)), 2);
  const limit = yLimit(peak);
  const cuts = new Map<number, number>();
  for (const { item, number } of chronology) {
    // A compression after request n sits on the boundary between n and n + 1.
    if (item.kind === "compaction" && number >= start && number <= end) cuts.set(number, (cuts.get(number) ?? 0) + 1);
  }
  const markers = [...cuts].map(([number, times]) => {
    const description = number ? `第 ${number} 次请求后，压缩 ${times} 次` : `首个请求前，压缩 ${times} 次`;
    return `<span class="compression-line" role="img" aria-label="${description}" style="--at:${100 * (number - start) / (end - start)}%"></span>`;
  }).join("");

  ui.requestChart.innerHTML = `<div class="request-plot" role="group" aria-label="第 ${start + 1} 至 ${end} 次请求的 Token 用量">
    <div class="axis-labels numeric" aria-hidden="true"><span>${compactNumber(limit)}</span><span>${compactNumber(limit / 2)}</span><span>0</span></div>
    <div class="request-points" style="--points:${visibleRequests.length}">${pointsForChart(visibleRequests, limit)}${markers}</div>
  </div>`;
  showRequest(visibleRequests.find(({ number }) => number === currentRequest) ?? visibleRequests[visibleRequests.length - 1]);
}

function eventMarkup({ item, number }: TimelineEntry, running: Set<TimelineItem>): string {
  const title = timelineLabel(item, number);
  let extra = "";
  let mark: string = item.kind;
  if (item.kind === "request") {
    if (item.model) extra = `<span class="event-extra">${escapeHtml(item.model)}</span>`;
    if (item.status === "failed") mark = "failed";
  } else if (item.kind !== "compaction") {
    const name = item.agentType || item.agentId.slice(-8);
    extra = `<span class="event-extra" title="${escapeHtml(item.agentId)}">${escapeHtml(name)}</span>`;
    if (running.has(item)) extra += '<span class="event-extra event-running">运行中</span>';
  }
  const currentDate = monthDay.format(Date.now());
  const eventDate = monthDay.format(item.timestamp);
  const day = currentDate !== eventDate ? `<span class="event-day">${eventDate}</span>` : "";
  return `<li class="event-row">
    <span class="event-mark" data-kind="${mark}" aria-hidden="true"></span>
    <div class="event-copy"><strong>${title}</strong>${extra}</div>
    <time class="event-clock numeric" datetime="${new Date(item.timestamp).toISOString()}" title="${longDate.format(item.timestamp)}">${day}${clock.format(item.timestamp)}</time>
  </li>`;
}

function renderEvents(): void {
  const active = new Map<string, TimelineItem>();
  for (const { item } of chronology) {
    if (item.kind === "agent-start") active.set(item.agentId, item);
    if (item.kind === "agent-stop") active.delete(item.agentId);
  }
  const running = new Set(active.values());
  const chosen = chronology.filter(({ item }) => eventFilter === "all" || item.kind !== "request" || item.status !== "completed");
  const rows = chosen.slice(Math.max(0, chosen.length - eventLimit)).reverse();
  ui.events.innerHTML = rows.length
    ? `<ol class="event-list">${rows.map((entry) => eventMarkup(entry, running)).join("")}</ol>`
    : box(eventFilter === "key" ? "暂无压缩、子代理或异常请求" : "暂无事件");

  const more = chosen.length - eventLimit;
  ui.moreEvents.hidden = chosen.length <= defaultEventLimit;
  ui.moreEvents.dataset.action = more > 0 ? "expand-events" : "collapse-events";
  ui.moreEvents.setAttribute("aria-expanded", String(eventLimit > defaultEventLimit));
  ui.moreEvents.textContent = more > 0 ? `再显示 ${Math.min(8, more)} 条` : "收起";
}

function renderSession(session: DashboardSnapshot["session"]): void {
  ui.activity.hidden = session.status !== "ready";
  if (session.status !== "ready") {
    ui.sessionState.hidden = true;
    ui.sessionFigures.innerHTML = box(session.status === "waiting" ? "等待当前对话产生请求" : "当前对话数据不可用");
    return;
  }

  let number = 0;
  requests = [];
  chronology = session.timeline.toSorted((a, b) => a.timestamp - b.timestamp).map((item) => {
    if (item.kind === "request") {
      number++;
      requests.push({ item, number });
    }
    return { item, number };
  });
  renderTotals(session.totals);
  renderTrend();
  renderEvents();
}

function showSnapshot(snapshot: DashboardSnapshot): void {
  const signature = JSON.stringify(snapshot);
  if (snapshotSignature !== signature) {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement ? active.dataset.focusKey : undefined;
    renderQuota(snapshot.account.quota);
    renderDaily(snapshot.account.usage);
    renderSession(snapshot.session);
    snapshotSignature = signature;
    ui.snapshot.hidden = false;
    if (focusKey && !active?.isConnected) {
      const target = [...ui.root.querySelectorAll<HTMLButtonElement>("[data-focus-key]")].find((button) => button.dataset.focusKey === focusKey);
      target?.focus({ preventScroll: true });
    }
  }
  const now = Date.now();
  ui.timestamp.textContent = `${clock.format(now)} 更新`;
  ui.timestamp.title = `最近读取 ${longDate.format(now)}`;
  ui.timestamp.hidden = false;
  setNotice(null);
}

function setNotice(kind: "loading" | "error" | "previous" | null, message = ""): void {
  ui.notice.hidden = kind === null;
  if (kind) ui.notice.dataset.kind = kind;
  if (ui.noticeText.textContent !== message) ui.noticeText.textContent = message;
}

function setReadError(): void {
  if (snapshotSignature !== undefined) {
    setNotice("previous", "刷新失败，显示上次读取的数据。");
  } else {
    setNotice("error", "读取用量失败，请刷新重试。");
  }
}

ui.root.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("button");
  if (!button) return;

  const { day, request, action, eventFilter: filter } = button.dataset;
  if (day) {
    currentDay = day;
    showDay(day);
  } else if (request) {
    const entry = visibleRequests.find(({ number }) => number === Number(request));
    if (entry) {
      currentRequest = entry.number;
      showRequest(entry);
    }
  } else if (action === "older" || action === "newer") {
    currentRequest = null;
    requestPage += action === "older" ? 1 : -1;
    renderTrend();
    if (button.disabled) (action === "older" ? ui.newer : ui.older).focus({ preventScroll: true });
  } else if (filter === "key" || filter === "all") {
    eventFilter = filter;
    eventLimit = defaultEventLimit;
    for (const option of ui.root.querySelectorAll<HTMLButtonElement>("[data-event-filter]")) {
      option.setAttribute("aria-pressed", String(option.dataset.eventFilter === filter));
    }
    renderEvents();
  } else if (button === ui.moreEvents) {
    eventLimit = action === "collapse-events" ? defaultEventLimit : eventLimit + 8;
    renderEvents();
  }
});

function setTheme(theme: string | undefined): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function busy(value: boolean): void {
  ui.refresh.setAttribute("aria-busy", String(value));
  ui.refresh.setAttribute("aria-disabled", String(value || ui.refresh.disabled));
}

const params = new URLSearchParams(window.location.search);
const demoState = params.get("state");
const explicitDemo = demoState === "ready" || demoState === "empty" || demoState === "error";

function renderDemo(state: DemoState): void {
  if (state === "error") {
    ui.snapshot.hidden = true;
    ui.timestamp.hidden = true;
    snapshotSignature = undefined;
    setReadError();
  } else {
    showSnapshot(state === "ready" ? readyDemo(Date.now()) : demoEmpty);
  }
}

function startDemo(): void {
  let state: DemoState = explicitDemo ? demoState : "ready";
  let refreshing = false;
  document.documentElement.dataset.demo = "true";
  ui.demoControls.hidden = false;
  ui.demoState.value = state;
  const initialTheme = params.get("theme");
  ui.demoTheme.value = initialTheme === "light" || initialTheme === "dark" ? initialTheme : "system";
  setTheme(ui.demoTheme.value);
  ui.refresh.disabled = false;
  renderDemo(state);

  ui.demoTheme.addEventListener("change", () => setTheme(ui.demoTheme.value));
  ui.demoState.addEventListener("change", () => {
    state = ui.demoState.value as DemoState;
    currentDay = null;
    currentRequest = null;
    requestPage = 0;
    renderDemo(state);
  });
  ui.refresh.addEventListener("click", () => {
    if (refreshing) return;
    refreshing = true;
    busy(true);
    window.setTimeout(() => {
      refreshing = false;
      busy(false);
      renderDemo(state);
    }, 230);
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is DashboardSnapshot {
  return record(value) && record(value.session) && record(value.account)
    && record(value.account.quota) && record(value.account.usage)
    && Array.isArray(value.session.timeline) && Array.isArray(value.account.quota.windows) && Array.isArray(value.account.usage.days);
}

function startApp(): void {
  const refreshInterval = 5_000;
  let app: App | null = null;
  let connected = false;
  let connecting = false;
  let refreshing = false;
  let stopped = false;
  let viewId: string | undefined;
  let resultTimeout: number | undefined;
  let lastAttempt = 0;
  let onScreen = true;

  function enableRefresh(): void {
    ui.refresh.disabled = stopped || connecting || (connected && !viewId);
    busy(refreshing);
  }

  async function refresh(): Promise<void> {
    if (!app || !connected || !viewId || stopped || refreshing) return;
    const requestedView = viewId;
    lastAttempt = Date.now();
    refreshing = true;
    enableRefresh();
    try {
      const result = await app.callServerTool({ name: "read_dashboard", arguments: { viewId: requestedView } }, { timeout: 16_000 });
      if (stopped || viewId !== requestedView) return;
      if (result.isError || !isSnapshot(result.structuredContent)) {
        setReadError();
        return;
      }
      showSnapshot(result.structuredContent);
    } catch {
      if (!stopped) setReadError();
    } finally {
      refreshing = false;
      enableRefresh();
      if (!stopped && viewId && viewId !== requestedView) void refresh();
    }
  }

  function poll(): void {
    if (onScreen && document.visibilityState === "visible" && Date.now() - lastAttempt >= refreshInterval) void refresh();
  }

  const timer = window.setInterval(poll, refreshInterval);
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) poll();
  }) : null;
  observer?.observe(ui.root);
  document.addEventListener("visibilitychange", poll);

  function stop(): void {
    stopped = true;
    window.clearInterval(timer);
    window.clearTimeout(resultTimeout);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", poll);
    enableRefresh();
  }

  async function connect(): Promise<void> {
    if (connecting || connected || stopped) return;
    connecting = true;
    enableRefresh();
    setNotice("loading", "正在读取用量…");
    let transport: PostMessageTransport | undefined;
    try {
      const next = new App({ name: "Codex 用量", version: "0.1.1" });
      transport = new PostMessageTransport(window.parent, window.parent);
      app = next;

      next.addEventListener("hostcontextchanged", ({ theme }) => {
        if (theme) setTheme(theme);
      });
      next.addEventListener("toolresult", ({ isError, structuredContent }) => {
        window.clearTimeout(resultTimeout);
        const id = structuredContent?.viewId;
        if (isError || typeof id !== "string" || !id) {
          setNotice("error", "打开面板失败，请在对话中重新打开。");
          return;
        }
        viewId = id;
        enableRefresh();
        void refresh();
      });
      next.addEventListener("toolcancelled", () => {
        window.clearTimeout(resultTimeout);
        setNotice("error", "打开面板的请求已取消。");
      });
      next.onteardown = () => {
        stop();
        return {};
      };

      await next.connect(transport, { timeout: 10_000 });
      connected = true;
      setTheme(next.getHostContext()?.theme);
      if (viewId) void refresh();
      else resultTimeout = window.setTimeout(() => {
        if (!viewId && ui.notice.dataset.kind === "loading") setNotice("error", "等待面板数据超时，请在对话中重新打开。");
      }, 12_000);
    } catch {
      await transport?.close().catch(() => undefined);
      app = null;
      if (!stopped) setNotice("error", "未能连接聊天窗口，请刷新重试。");
    } finally {
      connecting = false;
      enableRefresh();
    }
  }

  ui.refresh.addEventListener("click", () => {
    if (connected) void refresh();
    else void connect();
  });
  void connect();
}

if (window.self === window.top || explicitDemo) startDemo();
else startApp();
