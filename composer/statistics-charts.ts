import { addDays, calendarDate, mondayOf } from "../src/usage-calendar.ts";
import { modelLabel, periodLabel, sumKnown, tokenNumber, type ModelUsage, type UsageGrain, type UsagePeriod } from "./statistics-data.ts";

const modelPalette = ["#50b7a7", "#73a0d7", "#c18ddb", "#eba86c", "#83b878", "#dd839a", "#b7ab70", "#6fb9d0"];
const shares = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function modelColors(models: readonly ModelUsage[]) {
  const keys = models.map((row) => modelLabel(row.model)).sort();
  return new Map(keys.map((name, index) => [name, modelPalette[index] ?? `hsl(${(index * 137.5) % 360} 52% 58%)`]));
}

function modelDot(color: string | undefined) {
  const dot = element("span", "cup-model-dot");
  if (color) dot.style.setProperty("--model-color", color);
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

export function renderHeatmap(
  container: HTMLElement, year: number, periods: readonly UsagePeriod[], weeks: readonly UsagePeriod[], grain: "day" | "week",
) {
  const map = element("div", "cup-calendar");
  map.style.setProperty("--weeks", String(weeks.length));
  const months = element("div", "cup-calendar-months");
  for (let month = 1; month <= 12; month++) {
    const first = calendarDate(year, month);
    const column = weeks.findIndex((week) => week.start <= first && first < week.end);
    if (column >= 0) {
      const label = element("span", "", `${month}月`);
      label.style.gridColumn = String(column + 1);
      months.append(label);
    }
  }
  const weekdays = element("div", "cup-calendar-weekdays");
  weekdays.setAttribute("aria-hidden", "true");
  if (grain === "day") {
    for (const day of ["一", "", "三", "", "五", "", "日"]) weekdays.append(element("span", "", day));
  }
  const grid = element("div", "cup-heatmap");
  grid.dataset.grain = grain;
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `${year} 年 Token 活动`);
  const peak = Math.max(1, ...periods.map((period) => period.tokens ?? 0));
  const byStart = new Map(periods.map((period) => [period.start, period]));
  const firstMonday = mondayOf(calendarDate(year));
  const cells = grain === "week" ? periods : Array.from({ length: weeks.length * 7 }, (_, index) => byStart.get(addDays(firstMonday, index)));

  for (const period of cells) {
    if (!period) {
      grid.append(element("span", "cup-calendar-spacer"));
      continue;
    }
    const cell = element("button", "cup-heatmap-cell");
    cell.type = "button";
    cell.tabIndex = -1;
    cell.dataset.activityPeriod = period.start;
    cell.dataset.heat = period.tokens === null ? "missing" : String(Math.ceil(4 * Math.sqrt(period.tokens / peak)));
    const title = `${periodLabel(period)} · ${period.tokens === null ? "暂无用量数据" : `${tokenNumber(period.tokens)} Token`}`;
    cell.setAttribute("aria-label", title);
    cell.setAttribute("aria-pressed", "false");
    grid.append(cell);
  }
  map.append(months, weekdays, grid);
  container.replaceChildren(map);
}

function periodBreakdown(period: UsagePeriod) {
  if (period.tokens === 0 && period.models.length === 0) {
    return { newTokens: 0, uncachedInput: 0, cachedInput: 0, output: 0 };
  }
  const uncachedInput = sumKnown(period.models.map((model) => model.uncachedInputTokens));
  const cachedInput = sumKnown(period.models.map((model) => model.cachedInputTokens));
  const output = sumKnown(period.models.map((model) => model.outputTokens));
  return { newTokens: sumKnown([uncachedInput, output]), uncachedInput, cachedInput, output };
}

function icebergTooltipBreakdown(period: UsagePeriod) {
  const { newTokens, uncachedInput, cachedInput, output } = periodBreakdown(period);
  const newLabel = newTokens !== null && (uncachedInput === null || output === null) ? "已记录新增" : "新增";
  const cacheHit = uncachedInput !== null && cachedInput !== null && uncachedInput + cachedInput > 0
    ? shares.format(cachedInput / (uncachedInput + cachedInput)) : "—";
  const fields = [
    [newLabel, tokenNumber(newTokens)],
    ["未缓存输入", tokenNumber(uncachedInput)],
    ["输出", tokenNumber(output)],
    ["缓存读取", tokenNumber(cachedInput)],
    ["缓存命中率", cacheHit],
  ];
  const breakdown = element("dl", "cup-iceberg-breakdown");
  for (const [label, value] of fields) {
    const row = element("div", "");
    row.append(element("dt", "", label), element("dd", "", value));
    breakdown.append(row);
  }
  return breakdown;
}

export function renderPeriodTooltip(
  tooltip: HTMLElement, period: UsagePeriod, colors: ReadonlyMap<string, string>, iceberg: boolean,
) {
  const total = period.tokens;
  const date = element("p", "cup-activity-tooltip-date", periodLabel(period));
  const unavailable = iceberg && period.models.length ? "总 Token 暂不可用" : "暂无用量数据";
  const count = element("p", "cup-activity-tooltip-total", total === null ? unavailable : `${tokenNumber(total)} Token`);
  tooltip.replaceChildren(date, count);
  if (iceberg) tooltip.append(icebergTooltipBreakdown(period));
  if (!period.models.length) return;

  const list = element("ul", "cup-activity-tooltip-models");
  for (const row of period.models) {
    const label = modelLabel(row.model);
    const name = element("span", "cup-activity-tooltip-model");
    name.append(modelDot(colors.get(label)), element("span", "", label));
    const amount = element("span", "cup-activity-tooltip-amount", tokenNumber(row.totalTokens, true));
    const share = total !== null && total > 0 && row.totalTokens !== null ? shares.format(row.totalTokens / total) : "—";
    const item = element("li", "");
    item.append(name, amount, element("span", "cup-activity-tooltip-share", share));
    list.append(item);
  }
  tooltip.append(list);
}

function axisLimit(peak: number) {
  const order = 10 ** Math.floor(Math.log10(peak));
  return order * ([1, 2, 4, 5, 8, 10].find((factor) => factor * order >= peak) ?? 10);
}

export function renderIcebergChart(container: HTMLElement, periods: readonly UsagePeriod[], grain: UsageGrain) {
  const breakdowns = periods.map(periodBreakdown);
  const newPeak = Math.max(0, ...breakdowns.map(({ newTokens }) => newTokens ?? 0));
  const cachedPeak = Math.max(0, ...breakdowns.map(({ cachedInput }) => cachedInput ?? 0));
  const peak = Math.max(newPeak, cachedPeak);
  const step = axisLimit(Math.max(1, Math.ceil(peak / 3)));
  const above = Math.max(1, Math.ceil(newPeak / step));
  const below = Math.max(1, Math.ceil(cachedPeak / step));
  const divisions = above + below;
  const chart = element("div", "cup-iceberg-plot");
  chart.style.setProperty("--bars", String(periods.length));
  chart.style.setProperty("--waterline", `${100 * above / divisions}%`);
  const axis = element("div", "cup-iceberg-axis");
  axis.setAttribute("aria-hidden", "true");
  const series = element("div", "cup-iceberg-series");
  const grid = element("div", "cup-iceberg-grid");
  grid.setAttribute("aria-hidden", "true");
  for (let tick = -above; tick <= below; tick++) {
    if (!peak && tick !== 0) continue;
    const position = `${100 * (tick + above) / divisions}%`;
    const label = element("span", "", tokenNumber(Math.abs(tick) * step, true));
    const line = element("span", "cup-iceberg-line");
    label.style.top = line.style.top = position;
    if (tick === 0) line.setAttribute("data-waterline", "");
    axis.append(label);
    grid.append(line);
  }
  const bars = element("div", "cup-iceberg-bars");
  bars.setAttribute("role", "group");
  bars.setAttribute("aria-label", "Token 冰山图，水线上方为新增，下方为缓存读取，共用同一刻度");
  const ticks = element("div", "cup-iceberg-ticks");
  ticks.setAttribute("aria-hidden", "true");
  const tickStep = grain === "month" ? 1 : Math.max(1, Math.ceil(periods.length / 9));

  periods.forEach((period, index) => {
    const { newTokens, cachedInput } = breakdowns[index];
    const total = period.tokens;
    const bar = element("button", "cup-iceberg-bar");
    bar.type = "button";
    bar.dataset.modelPeriod = period.start;
    bar.disabled = total === null && period.models.length === 0;
    bar.setAttribute("aria-pressed", "false");
    bar.setAttribute("aria-label", `${periodLabel(period)} · ${total === null ? "总 Token 暂不可用" : `${tokenNumber(total)} Token`}`);

    for (const [style, amount] of [["cup-iceberg-new", newTokens], ["cup-iceberg-cached", cachedInput]] as const) {
      if (!amount) continue;
      const segment = element("span", `cup-iceberg-segment ${style}`);
      segment.style.height = `${100 * amount / (step * divisions)}%`;
      bar.append(segment);
    }
    if (!bar.hasChildNodes() && !bar.disabled) {
      bar.append(element("span", newTokens === 0 && cachedInput === 0 ? "cup-iceberg-zero" : "cup-iceberg-missing"));
    }
    const date = period.start;
    const label = grain === "day" ? String(Number(date.slice(8, 10))) : grain === "week" ? String(index + 1) : `${Number(date.slice(5, 7))}月`;
    const showTick = index % tickStep === 0 || (index === periods.length - 1 && index % tickStep > 1);
    ticks.append(element("span", "", showTick ? label : ""));
    bars.append(bar);
  });
  series.append(grid, bars, ticks);
  chart.append(axis, series);
  container.replaceChildren(chart);
}

export function renderModelRows(body: HTMLElement, models: readonly ModelUsage[], colors: ReadonlyMap<string, string>) {
  const rows = models.map((model) => {
    const row = element("tr", "");
    const header = element("th", "");
    header.scope = "row";
    const name = modelLabel(model.model);
    header.append(modelDot(colors.get(name)), element("span", "", name));
    row.append(header);
    for (const value of [model.totalTokens, model.uncachedInputTokens, model.cachedInputTokens, model.outputTokens]) {
      row.append(element("td", "", tokenNumber(value)));
    }
    return row;
  });
  body.replaceChildren(...rows);
}
