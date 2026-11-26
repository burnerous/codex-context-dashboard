import { keepLatestAccount } from "../src/account-data.ts";
import type { AccountSnapshot, SessionTotals } from "../src/dashboard-types.ts";
import { accountProperty, decodeSnapshot } from "../src/composer-contract.ts";
import type { NativeChatUsage } from "./native-usage.ts";

export const usagePanelContent = `
  <div class="cup-head cup-card-heading">
    <span>Codex 用量</span>
    <div class="cup-head-actions">
      <span class="cup-status">北京时间</span>
      <button type="button" class="cup-refresh" aria-label="刷新用量" title="刷新用量"><span class="cup-refresh-icon" aria-hidden="true"></span></button>
    </div>
  </div>
  <div class="cup-usage-body">
    <dl class="cup-usage-totals">
      <div><dt data-usage-token-label>本聊天 Token</dt><dd data-usage-total>—</dd></div>
      <div><dt>缓存命中率</dt><dd data-usage-cache>—</dd></div>
      <div><dt title="Codex 调用模型的次数。一轮对话可能包含多次调用。">已记录请求</dt><dd data-usage-requests data-pending>待记录</dd></div>
    </dl>
    <p class="cup-usage-detail" data-usage-detail></p>
    <p class="cup-usage-context" data-usage-context hidden></p>
    <div class="cup-usage-section">
      <div class="cup-head"><span>账户额度</span><span class="cup-status" data-quota-updated></span></div>
      <div class="cup-quota" data-usage-quota></div>
    </div>
    <div class="cup-usage-section cup-days-section">
      <div><div class="cup-head">近 7 天用量</div><p class="cup-usage-detail" data-usage-week></p></div>
      <div class="cup-days" data-usage-days role="img" hidden></div>
    </div>
  </div>
  <div class="cup-usage-footer">
    <button type="button" class="cup-detail-button" data-open-statistics>查看用量统计</button>
    <span class="cup-status" data-refresh-status role="status" hidden></span>
  </div>`;

const integers = new Intl.NumberFormat("zh-CN");
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const toolbarTokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const chinaTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const accountStaleMs = 5 * 60_000;

function textWithTitle(node: HTMLElement, count: number | null | undefined) {
  node.textContent = count == null ? "—" : compact.format(count);
  node.title = count == null ? "暂不可用" : `${integers.format(count)} Token`;
}

function renderQuota(container: HTMLElement, windows: AccountSnapshot["quota"]["windows"]) {
  if (!windows.length) {
    container.textContent = "暂不可用";
    return;
  }
  container.replaceChildren(...windows.map((window) => {
    const row = document.createElement("div");
    row.className = "cup-quota-row";
    const label = document.createElement("span");
    label.textContent = window.label;
    const amount = document.createElement("strong");
    const remaining = Math.max(0, 100 - window.usedPercent);
    amount.textContent = `${percent.format(remaining)}% 剩余`;
    const reset = document.createElement("span");
    reset.textContent = window.resetsAt === null ? "重置时间未知" : `${chinaTime.format(window.resetsAt)} 重置`;
    row.append(label, amount, reset);
    return row;
  }));
}

function renderDays(container: HTMLElement, days: AccountSnapshot["usage"]["days"]) {
  container.hidden = days.length === 0;
  const max = Math.max(1, ...days.map(({ tokens }) => tokens));
  const labels = days.map(({ date, tokens }) => `${date.slice(5)} · ${integers.format(tokens)} Token`);
  container.setAttribute("aria-label", labels.join("，"));
  container.replaceChildren(...days.map(({ tokens }, index) => {
    const bar = document.createElement("span");
    bar.style.setProperty("--cup-day-height", `${100 * tokens / max}%`);
    bar.title = labels[index];
    return bar;
  }));
}

export function bindUsagePreview(panel: HTMLElement, root: HTMLElement) {
  const get = (selector: string) => panel.querySelector<HTMLElement>(selector)!;
  const button = root.querySelector<HTMLButtonElement>("[data-usage-trigger]")!;
  const buttonTotal = root.querySelector<HTMLElement>("[data-usage-button-total]")!;
  const buttonCache = root.querySelector<HTMLElement>("[data-usage-button-cache]")!;
  const total = get("[data-usage-total]");
  const tokenLabel = get("[data-usage-token-label]");
  const cache = get("[data-usage-cache]");
  const requests = get("[data-usage-requests]");
  const detail = get("[data-usage-detail]");
  const quota = get("[data-usage-quota]");
  const quotaUpdated = get("[data-quota-updated]");
  const week = get("[data-usage-week]");
  const days = get("[data-usage-days]");
  let previousChatText = "";
  let recorded: SessionTotals | null = null;
  let previousTotals: SessionTotals | NativeChatUsage | null = null;
  let cacheLabel = "—";
  let displayed = "";
  let displayedManualAccount: AccountSnapshot | null = null;

  return (chatText: string, styles: CSSStyleDeclaration, native: NativeChatUsage | null, manualAccount: AccountSnapshot | null) => {
    if (chatText !== previousChatText) {
      previousChatText = chatText;
      recorded = decodeSnapshot<SessionTotals>(chatText);
      displayed = "";
    }
    const usingNative = Boolean(native && (recorded?.partial || recorded?.totalTokens == null));
    const chat = usingNative ? native : recorded;
    const scope = usingNative ? "Codex 累计" : recorded?.partial ? "已记录" : "";
    if (chat !== previousTotals) {
      previousTotals = chat;
      displayed = "";
      cacheLabel = chat?.cacheHitPercent == null ? "—" : `${percent.format(chat.cacheHitPercent)}%`;
      buttonTotal.textContent = chat?.totalTokens == null ? "—" : toolbarTokens.format(chat.totalTokens);
      buttonCache.textContent = cacheLabel;
      const label = ["用量速览"];
      if (chat?.totalTokens != null) label.push(`${scope || "累计"} ${integers.format(chat.totalTokens)} Token`);
      if (chat?.cacheHitPercent != null) label.push(`缓存命中率 ${cacheLabel}`);
      button.setAttribute("aria-label", label.join("，"));
    }
    if (panel.hidden) return;
    const accountText = styles.getPropertyValue(accountProperty).trim();
    const now = Date.now();
    const key = [accountText, Math.floor(now / 60_000)].join("|");
    if (key === displayed && manualAccount === displayedManualAccount) return;
    displayed = key;
    displayedManualAccount = manualAccount;
    textWithTitle(total, chat?.totalTokens);
    tokenLabel.textContent = !usingNative && recorded?.partial ? "已记录 Token" : "本聊天 Token";
    cache.textContent = cacheLabel;
    requests.textContent = recorded ? integers.format(recorded.requests) : "待记录";
    requests.toggleAttribute("data-pending", !recorded);
    detail.textContent = chat
      ? `${scope ? `${scope} · ` : ""}输入 ${chat.inputTokens == null ? "—" : compact.format(chat.inputTokens)} · 输出 ${chat.outputTokens == null ? "—" : compact.format(chat.outputTokens)}`
      : "本聊天暂无可展示的用量";

    const cachedAccount = decodeSnapshot<AccountSnapshot>(accountText);
    const account = manualAccount ? keepLatestAccount(manualAccount, cachedAccount) : cachedAccount;
    const quotaAt = account?.quota?.updatedAt;
    const windows = account?.quota?.windows ?? [];
    const stale = quotaAt != null && (account?.quota.status === "stale" || now - quotaAt > accountStaleMs
      || windows.some(({ resetsAt }) => resetsAt != null && resetsAt <= now));
    quotaUpdated.textContent = quotaAt == null ? "" : `${stale ? "上次 " : ""}${chinaTime.format(quotaAt)}`;
    renderQuota(quota, windows);
    const recent = account?.usage?.days ?? [];
    textWithTitle(week, recent.length ? recent.reduce((sum, day) => sum + day.tokens, 0) : null);
    if (recent.length) week.textContent += " Token";
    else week.textContent = "暂不可用";
    renderDays(days, recent);
  };
}
