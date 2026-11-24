import type { UsageStatistics } from "../src/dashboard-types.ts";
import { beijingDate } from "../src/usage-calendar.ts";
import type { NativeDashboardReader } from "./native-dashboard.ts";
import { modelColors, renderHeatmap, renderIcebergChart, renderModelRows, renderPeriodTooltip } from "./statistics-charts.ts";
import { aggregateModels, periodLabel, sumKnown, tokenNumber, usagePeriods, type UsageGrain, type UsagePeriod } from "./statistics-data.ts";

export const usageStatisticsMarkup = `
  <dialog class="cup-statistics-dialog" aria-labelledby="cup-statistics-title">
    <header class="cup-statistics-header">
      <div><h2 id="cup-statistics-title">用量统计</h2><p data-statistics-coverage>北京时间</p></div>
      <div class="cup-statistics-actions">
        <button type="button" class="cup-refresh" data-statistics-refresh aria-label="刷新用量统计" title="刷新用量统计"><span class="cup-refresh-icon" aria-hidden="true"></span></button>
        <button type="button" class="cup-detail-button" data-statistics-close autofocus>关闭</button>
      </div>
    </header>
    <div class="cup-statistics-navigation">
      <div class="cup-statistics-tabs" role="tablist" aria-label="用量统计视图">
        <button type="button" id="cup-tab-activity" role="tab" aria-controls="cup-stats-activity" data-statistics-tab="activity">活动概览</button>
        <button type="button" id="cup-tab-models" role="tab" aria-controls="cup-stats-models" data-statistics-tab="models">用量详情</button>
      </div>
      <div class="cup-segments" role="group" aria-label="统计范围">
        <button type="button" data-statistics-scope="local">本机全部</button>
        <button type="button" data-statistics-scope="chat">当前会话</button>
      </div>
    </div>
    <p class="cup-statistics-status" data-statistics-status role="status"></p>
    <div data-statistics-content hidden>
      <dl class="cup-statistics-totals">
        <div><dt>今日用量</dt><dd data-statistics-total="today">—</dd></div>
        <div><dt>本周用量</dt><dd data-statistics-total="week">—</dd></div>
        <div><dt>本月用量</dt><dd data-statistics-total="month">—</dd></div>
        <div><dt>累计用量</dt><dd data-statistics-total="all">—</dd></div>
      </dl>
      <section class="cup-statistics-view" id="cup-stats-activity" role="tabpanel" aria-labelledby="cup-tab-activity" data-statistics-panel="activity">
        <div class="cup-statistics-section-head">
          <h3>Token 活动</h3>
          <div class="cup-statistics-actions">
            <div class="cup-segments" role="group" aria-label="活动粒度">
              <button type="button" data-activity-grain="day">每天</button>
              <button type="button" data-activity-grain="week">每周</button>
            </div>
            <select data-activity-year aria-label="活动年份"></select>
          </div>
        </div>
        <div class="cup-statistics-scroll" data-activity-calendar></div>
        <div class="cup-heatmap-caption">
          <span data-activity-total></span>
          <span class="cup-heatmap-legend" aria-label="颜色越深，用量越高">少 <i data-heat="0"></i><i data-heat="1"></i><i data-heat="2"></i><i data-heat="3"></i><i data-heat="4"></i> 多</span>
        </div>
        <div class="cup-activity-selection">
          <div><strong data-activity-selection></strong><span data-activity-tokens></span></div>
          <button type="button" class="cup-detail-button" data-see-usage>查看用量详情</button>
        </div>
      </section>
      <section class="cup-statistics-view" id="cup-stats-models" role="tabpanel" aria-labelledby="cup-tab-models" data-statistics-panel="models" hidden>
        <div class="cup-statistics-section-head">
          <h3>按模型统计</h3>
          <div class="cup-statistics-actions cup-statistics-model-controls">
            <div class="cup-statistics-period">
              <button type="button" class="cup-detail-button" data-period-previous aria-label="上一时段">‹</button>
              <strong data-model-range></strong>
              <button type="button" class="cup-detail-button" data-period-next aria-label="下一时段">›</button>
            </div>
            <div class="cup-segments" role="group" aria-label="用量粒度">
              <button type="button" data-model-grain="day">天</button>
              <button type="button" data-model-grain="week">周</button>
              <button type="button" data-model-grain="month">月</button>
            </div>
          </div>
        </div>
        <div class="cup-iceberg-key">
          <span><i class="cup-iceberg-swatch cup-iceberg-new" aria-hidden="true"></i>新增<span class="cup-iceberg-key-detail">未缓存输入 + 输出</span></span>
          <span><i class="cup-iceberg-swatch cup-iceberg-cached" aria-hidden="true"></i>缓存读取</span>
        </div>
        <div class="cup-statistics-scroll" data-model-chart></div>
        <p class="cup-model-summary" data-model-summary></p>
        <div class="cup-statistics-scroll" data-model-table>
          <table class="cup-statistics-table" aria-label="模型用量汇总">
            <thead><tr><th scope="col">模型</th><th scope="col">总 Token</th><th scope="col">未缓存输入</th><th scope="col">缓存读取</th><th scope="col">输出</th></tr></thead>
            <tbody data-model-rows></tbody>
          </table>
          <p class="cup-statistics-empty" data-model-empty hidden>此时段暂无已记录用量</p>
        </div>
      </section>
    </div>
    <div class="cup-activity-tooltip" id="cup-activity-tooltip" role="tooltip" hidden></div>
  </dialog>`;

type View = "activity" | "models";
type Scope = "local" | "chat";

interface PanelEvents {
  on<K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void): void;
}

function withTokens(value: number | null, shorten = false) {
  return value === null ? "—" : `${tokenNumber(value, shorten)} Token`;
}

export function bindUsageStatistics(dialog: HTMLDialogElement, reader: NativeDashboardReader, ctx: PanelEvents) {
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const buttons = (selector: string) => [...dialog.querySelectorAll<HTMLButtonElement>(selector)];
  const tabs = buttons("[data-statistics-tab]");
  const scopes = buttons("[data-statistics-scope]");
  const activityGrains = buttons("[data-activity-grain]");
  const modelGrains = buttons("[data-model-grain]");
  const chart = get("[data-model-chart]");
  const calendar = get("[data-activity-calendar]");
  const tooltip = get("#cup-activity-tooltip");
  const years = get<HTMLSelectElement>("[data-activity-year]");
  const previous = get<HTMLButtonElement>("[data-period-previous]");
  const next = get<HTMLButtonElement>("[data-period-next]");
  const seeUsage = get<HTMLButtonElement>("[data-see-usage]");
  const refresh = get<HTMLButtonElement>("[data-statistics-refresh]");
  const notice = get("[data-statistics-status]");
  const content = get("[data-statistics-content]");

  let threadId: string | null = null;
  let scope: Scope = "local";
  let view: View = "activity";
  let activityGrain: "day" | "week" = "day";
  let modelGrain: UsageGrain = "day";
  let year = 0;
  let month = 1;
  let activityDate: string | null = null;
  let modelDate: string | null = null;
  let snapshot: UsageStatistics | null = null;
  let colors: ReadonlyMap<string, string> = new Map();
  let activityPeriods: UsagePeriod[] = [];
  let modelPeriods: UsagePeriod[] = [];
  let tooltipAnchor: HTMLButtonElement | null = null;
  let sequence = 0;

  const monthOf = (date: string) => Number(date.slice(5, 7));
  const yearOf = (date: string) => Number(date.slice(0, 4));
  const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

  function periodButton(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLButtonElement>("[data-activity-period], [data-model-period]") : null;
  }

  function hideTooltip() {
    tooltipAnchor?.removeAttribute("aria-describedby");
    tooltipAnchor = null;
    tooltip.hidden = true;
  }

  function showTooltip(anchor: HTMLButtonElement | null, cursorY?: number) {
    if (!anchor || anchor.disabled || tooltipAnchor === anchor) return;
    const icebergDate = anchor.dataset.modelPeriod;
    const iceberg = icebergDate !== undefined;
    const periods = iceberg ? modelPeriods : activityPeriods;
    const period = periods.find((item) => item.start === (icebergDate ?? anchor.dataset.activityPeriod));
    if (!period) return;
    hideTooltip();
    renderPeriodTooltip(tooltip, period, colors, iceberg);
    const gap = 8;
    const frame = dialog.getBoundingClientRect();
    const cell = anchor.getBoundingClientRect();
    const insideLeft = frame.left + dialog.clientLeft;
    const insideTop = frame.top + dialog.clientTop;
    const leftEdge = Math.max(0, insideLeft) + gap;
    const rightEdge = Math.min(window.innerWidth, insideLeft + dialog.clientWidth) - gap;
    const topEdge = Math.max(0, insideTop) + gap;
    const bottomEdge = Math.min(window.innerHeight, insideTop + dialog.clientHeight) - gap;
    const scrollOriginX = insideLeft - dialog.scrollLeft;
    const scrollOriginY = insideTop - dialog.scrollTop;
    tooltip.style.left = `${leftEdge - scrollOriginX}px`;
    tooltip.style.top = `${topEdge - scrollOriginY}px`;
    tooltip.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
    tooltip.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
    tooltip.hidden = false;
    const { width, height } = tooltip.getBoundingClientRect();
    const beside = cell.right + gap + width <= rightEdge ? cell.right + gap : cell.left - gap - width;
    const left = iceberg ? beside : cell.left + (cell.width - width) / 2;
    const above = cell.top - gap - height;
    const top = iceberg ? (cursorY ?? cell.top + cell.height / 2) - gap : (above >= topEdge ? above : cell.bottom + gap);
    tooltip.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - width)) - scrollOriginX}px`;
    tooltip.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height)) - scrollOriginY}px`;
    tooltipAnchor = anchor;
    anchor.setAttribute("aria-describedby", tooltip.id);
  }

  function drawNavigation() {
    for (const tab of tabs) {
      const selected = tab.dataset.statisticsTab === view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const button of scopes) {
      button.setAttribute("aria-pressed", String(button.dataset.statisticsScope === scope));
      button.disabled = button.dataset.statisticsScope === "chat" && !threadId;
    }
    get("[data-statistics-panel='activity']").hidden = view !== "activity";
    get("[data-statistics-panel='models']").hidden = view !== "models";
  }

  function selectActivity(date: string | null, focus = false) {
    const period = activityPeriods.find((item) => item.start === date);
    activityDate = period?.start ?? null;
    get("[data-activity-selection]").textContent = period ? periodLabel(period) : "";
    get("[data-activity-tokens]").textContent = period ? withTokens(period.tokens) : "";
    seeUsage.disabled = !period || period.models.length === 0;
    for (const button of calendar.querySelectorAll<HTMLButtonElement>("[data-activity-period]")) {
      const selected = button.dataset.activityPeriod === activityDate;
      button.setAttribute("aria-pressed", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus({ preventScroll: true });
    }
  }

  function drawActivity(data: UsageStatistics) {
    for (const button of activityGrains) button.setAttribute("aria-pressed", String(button.dataset.activityGrain === activityGrain));
    const earliest = yearOf(data.firstDate ?? data.today);
    const latest = yearOf(data.today);
    const options: HTMLOptionElement[] = [];
    for (let option = latest; option >= Math.min(year, earliest); option--) options.push(new Option(`${option} 年`, String(option)));
    years.replaceChildren(...options);
    years.value = String(year);
    const weeks = usagePeriods(data, "week");
    activityPeriods = activityGrain === "week" ? weeks : usagePeriods(data, "day");
    renderHeatmap(calendar, year, activityPeriods, weeks, activityGrain);
    const defaultDate = year === latest ? data.today : data.days.at(-1)?.date;
    const selected = activityPeriods.find((period) => period.start === activityDate)
      ?? activityPeriods.find((period) => defaultDate && period.start <= defaultDate && defaultDate < period.end)
      ?? activityPeriods[0];
    selectActivity(selected?.start ?? null);
    const total = sumKnown(activityPeriods.map((period) => period.tokens));
    get("[data-activity-total]").textContent = `${year} 年 · ${withTokens(total)}`;
  }

  function drawModelTable() {
    const allModels = aggregateModels(modelPeriods.flatMap((period) => period.models));
    const selected = modelPeriods.find((period) => period.start === modelDate);
    const models = selected?.models ?? allModels;
    const total = selected ? selected.tokens : sumKnown(modelPeriods.map((period) => period.tokens));
    const label = selected ? periodLabel(selected) : modelGrain === "day" ? monthKey(year, month) : `${year} 年`;
    get("[data-model-summary]").textContent = `${label} · ${withTokens(total)}`;
    get("[data-model-empty]").hidden = models.length > 0;
    renderModelRows(get("[data-model-rows]"), models, colors);
    for (const bar of chart.querySelectorAll<HTMLButtonElement>("[data-model-period]")) {
      bar.setAttribute("aria-pressed", String(bar.dataset.modelPeriod === modelDate));
    }
  }

  function drawModels(data: UsageStatistics) {
    const daily = modelGrain === "day";
    for (const button of modelGrains) button.setAttribute("aria-pressed", String(button.dataset.modelGrain === modelGrain));
    get("[data-model-range]").textContent = daily ? monthKey(year, month) : `${year} 年`;
    const earliest = data.firstDate ?? data.today;
    previous.disabled = daily ? monthKey(year, month) <= earliest.slice(0, 7) : year <= yearOf(earliest);
    next.disabled = daily ? monthKey(year, month) >= data.today.slice(0, 7) : year >= yearOf(data.today);
    modelPeriods = usagePeriods(data, modelGrain, daily ? month : undefined);
    renderIcebergChart(chart, modelPeriods, modelGrain);
    drawModelTable();
  }

  function draw() {
    hideTooltip();
    drawNavigation();
    if (!snapshot) return;
    for (const [period, value] of Object.entries(snapshot.totals)) {
      const metric = get(`[data-statistics-total="${period}"]`);
      metric.textContent = tokenNumber(value, true);
      if (value !== null) {
        const unit = document.createElement("span");
        unit.textContent = " Token";
        metric.append(unit);
      }
      metric.title = withTokens(value);
    }
    if (view === "activity") drawActivity(snapshot);
    else drawModels(snapshot);
  }

  async function load(resetMonth: boolean) {
    const loading = ++sequence;
    hideTooltip();
    snapshot = null;
    content.hidden = true;
    notice.hidden = false;
    notice.textContent = "正在读取用量…";
    get("[data-statistics-coverage]").textContent = "北京时间";
    refresh.disabled = true;
    drawNavigation();
    const result = await reader.readStatistics(year, scope === "chat" ? threadId! : "local").catch(() => null);
    if (sequence !== loading || !dialog.open || !dialog.isConnected) return;
    refresh.disabled = false;
    if (!result) {
      notice.textContent = "用量暂不可用，请刷新重试。";
      return;
    }
    snapshot = result;
    colors = modelColors(aggregateModels(result.days));
    if (resetMonth) {
      const date = year === yearOf(result.today) ? result.today : result.days.at(-1)?.date;
      month = date ? monthOf(date) : 1;
    }
    notice.hidden = result.firstDate !== null;
    notice.textContent = result.firstDate === null ? "当前范围暂无已记录用量" : "";
    get("[data-statistics-coverage]").textContent = result.firstDate
      ? `始于 ${result.firstDate} · 北京时间` : "北京时间";
    content.hidden = false;
    draw();
  }

  function moveModelPeriod(direction: number) {
    if (modelGrain !== "day") {
      year += direction;
      modelDate = null;
      activityDate = null;
      void load(true);
      return;
    }
    const moved = month + direction;
    modelDate = null;
    if (moved < 1 || moved > 12) {
      year += direction;
      month = moved < 1 ? 12 : 1;
      activityDate = null;
      void load(false);
    } else {
      month = moved;
      draw();
    }
  }

  for (const tab of tabs) {
    ctx.on(tab, "click", () => {
      view = tab.dataset.statisticsTab as View;
      draw();
    });
    ctx.on(tab, "keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const other = tabs.find((button) => button !== tab);
      other?.click();
      other?.focus();
    });
  }
  for (const button of scopes) ctx.on(button, "click", () => {
    const target = button.dataset.statisticsScope as Scope;
    if (target === scope || (target === "chat" && !threadId)) return;
    scope = target;
    year = yearOf(beijingDate(Date.now()));
    activityDate = modelDate = null;
    void load(true);
  });
  for (const button of activityGrains) ctx.on(button, "click", () => {
    const target = button.dataset.activityGrain as "day" | "week";
    if (target === activityGrain) return;
    const date = activityDate;
    activityGrain = target;
    if (snapshot && date) {
      activityDate = usagePeriods(snapshot, target).find((period) => period.start <= date && date < period.end)?.start ?? null;
    }
    draw();
  });
  for (const button of modelGrains) ctx.on(button, "click", () => {
    modelGrain = button.dataset.modelGrain as UsageGrain;
    modelDate = null;
    draw();
  });
  ctx.on(years, "change", () => {
    year = Number(years.value);
    activityDate = modelDate = null;
    void load(true);
  });
  ctx.on(refresh, "click", () => { void load(false); });
  ctx.on(previous, "click", () => moveModelPeriod(-1));
  ctx.on(next, "click", () => moveModelPeriod(1));
  ctx.on(calendar, "click", (event) => {
    const date = periodButton(event.target)?.dataset.activityPeriod;
    if (date) selectActivity(date);
  });
  for (const plot of [calendar, chart]) {
    ctx.on(plot, "pointerover", (event) => {
      if (event.pointerType !== "touch") showTooltip(periodButton(event.target), event.clientY);
    });
    ctx.on(plot, "pointerout", (event) => {
      if (periodButton(event.target) === tooltipAnchor && periodButton(event.relatedTarget) !== tooltipAnchor) hideTooltip();
    });
    ctx.on(plot, "focusin", (event) => {
      const anchor = periodButton(event.target);
      if (anchor?.matches(":focus-visible")) showTooltip(anchor);
    });
    ctx.on(plot, "focusout", (event) => {
      if (periodButton(event.target) === tooltipAnchor) hideTooltip();
    });
    ctx.on(plot, "scroll", hideTooltip);
  }
  ctx.on(dialog, "scroll", hideTooltip);
  ctx.on(window, "resize", hideTooltip);
  ctx.on(calendar, "keydown", (event) => {
    const horizontal = activityGrain === "day" ? 7 : 1;
    const moves: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -horizontal, ArrowRight: horizontal };
    const offset = moves[event.key];
    if (!offset) return;
    event.preventDefault();
    const index = activityPeriods.findIndex((period) => period.start === activityDate);
    const target = Math.max(0, Math.min(activityPeriods.length - 1, index + offset));
    selectActivity(activityPeriods[target]?.start ?? null, true);
  });
  ctx.on(seeUsage, "click", () => {
    if (!activityDate) return;
    modelGrain = activityGrain;
    month = monthOf(activityDate);
    modelDate = activityDate;
    view = "models";
    draw();
    tabs[1].focus({ preventScroll: true });
  });
  ctx.on(chart, "click", (event) => {
    const date = periodButton(event.target)?.dataset.modelPeriod;
    if (!date) return;
    modelDate = modelDate === date ? null : date;
    drawModelTable();
  });

  return {
    open(id: string | null) {
      threadId = id;
      scope = "local";
      view = "activity";
      activityGrain = modelGrain = "day";
      activityDate = modelDate = null;
      year = yearOf(beijingDate(Date.now()));
      dialog.scrollTop = 0;
      void load(true);
    },
    close() {
      ++sequence;
      snapshot = null;
      hideTooltip();
    },
  };
}
