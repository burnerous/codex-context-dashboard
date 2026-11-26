import type { NativeChatContext } from "./native-usage.ts";

export const contextTriggerContent = [
  '<span class="cup-trigger-icon cup-context-ring" aria-hidden="true"></span>',
  '<span class="cup-trigger-value"><strong data-context-button-value>—</strong></span>',
].join("");

export const contextPanelContent = [
  '<div class="cup-head cup-card-heading">上下文窗口</div>',
  '<div class="cup-context-hero" data-context-hero hidden>',
  '  <div class="cup-context-percent"><strong data-context-percent></strong><span>已占用</span></div>',
  '  <span class="cup-context-remaining" data-context-remaining></span>',
  '</div>',
  '<div class="cup-context-meter" data-context-meter aria-hidden="true" hidden></div>',
  '<dl class="cup-context-amounts" data-context-amounts hidden>',
  '  <div><dt>已用</dt><dd data-context-used></dd></div>',
  '  <div><dt>窗口上限</dt><dd data-context-window></dd></div>',
  '</dl>',
  '<p class="cup-note cup-context-note" data-context-note></p>',
].join("");

const integers = new Intl.NumberFormat("zh-CN");

export function bindContextPreview(button: HTMLButtonElement, card: HTMLElement, usageContext: HTMLElement) {
  const buttonValue = button.querySelector<HTMLElement>("[data-context-button-value]")!;
  const hero = card.querySelector<HTMLElement>("[data-context-hero]")!;
  const percentage = card.querySelector<HTMLElement>("[data-context-percent]")!;
  const remaining = card.querySelector<HTMLElement>("[data-context-remaining]")!;
  const meter = card.querySelector<HTMLElement>("[data-context-meter]")!;
  const amounts = card.querySelector<HTMLElement>("[data-context-amounts]")!;
  const used = card.querySelector<HTMLElement>("[data-context-used]")!;
  const windowSize = card.querySelector<HTMLElement>("[data-context-window]")!;
  const note = card.querySelector<HTMLElement>("[data-context-note]")!;
  let previous: NativeChatContext | null | undefined;
  let previousChat = false;

  return (snapshot: NativeChatContext | null, hasChat: boolean) => {
    if (snapshot === previous && hasChat === previousChat) return;
    previous = snapshot;
    previousChat = hasChat;

    const windowTokens = snapshot?.windowTokens ?? null;
    const ratio = snapshot && windowTokens !== null ? Math.min(1, snapshot.usedTokens / windowTokens) : null;
    const percent = ratio === null ? "—" : ratio > 0 && ratio < 0.01 ? "<1%"
      : (ratio < 1 ? Math.min(99, Math.round(100 * ratio)) : 100) + "%";
    const usedLabel = snapshot ? integers.format(snapshot.usedTokens) + " Token" : "—";
    const windowLabel = windowTokens === null ? "—" : integers.format(windowTokens) + " Token";
    const state = snapshot
      ? windowTokens === null ? "Codex 暂未上报窗口上限。" : "Codex 最近一次上报"
      : hasChat ? "等待 Codex 上报此对话的上下文用量。" : "开始对话后可查看上下文用量。";

    buttonValue.textContent = percent;
    button.setAttribute("aria-label", ratio === null ? "上下文窗口，" + state : "上下文窗口，已占用 " + percent);
    button.style.setProperty("--cup-context-fill", (ratio === null ? 0 : ratio * 100) + "%");
    button.toggleAttribute("data-context-near-limit", ratio !== null && ratio >= 0.85);
    card.toggleAttribute("data-context-near-limit", ratio !== null && ratio >= 0.85);

    hero.hidden = meter.hidden = ratio === null;
    amounts.hidden = snapshot === null;
    percentage.textContent = percent;
    meter.style.setProperty("--cup-context-fill", (ratio === null ? 0 : ratio * 100) + "%");
    remaining.textContent = snapshot && windowTokens !== null
      ? snapshot.usedTokens > windowTokens ? "已超过窗口上限"
        : "剩余 " + integers.format(windowTokens - snapshot.usedTokens) + " Token"
      : "";
    used.textContent = usedLabel;
    windowSize.textContent = windowLabel;
    note.textContent = state;
    usageContext.textContent = ratio !== null ? "上下文 " + percent + " · " + usedLabel.replace(" Token", "") + " / " + windowLabel
      : snapshot ? "上下文已用 " + usedLabel + " · 上限未知" : "上下文用量待上报";
  };
}
