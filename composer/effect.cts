import { Tiktoken } from "js-tiktoken/lite";
import ranks from "composer-speed-ranks";
import { bindUsagePreview, usagePanelContent } from "./dashboard-preview.ts";
import {
  buttonGap, composerSlot, currentComposer, homeComposerSelector, pendingComposerMarker, visibleComposerElement,
} from "./layout.ts";
import { NativeChatActivity } from "./native-activity.ts";
import { NativeDashboardReader } from "./native-dashboard.ts";
import { NativeChatSpeed } from "./native-speed.ts";
import { nativeChatUsage, type NativeChatUsage } from "./native-usage.ts";
import { speedHistoryLimit } from "./speed-history.ts";
import { drawSpeedChart } from "./speed-chart.ts";
import { bindUsageStatistics, usageStatisticsMarkup } from "./statistics-panel.ts";
import { keepLatestAccount } from "../src/account-data.ts";
import { chatProperty, localChatId, sessionIdFromSidebar } from "../src/composer-contract.ts";
import type { AccountSnapshot } from "../src/dashboard-types.ts";
import style from "./effect.css";
import statisticsStyle from "./statistics.css";

interface EffectContext {
  host: string;
  layer: HTMLElement;
  selectors: Record<string, string>;
  style(css: string): void;
  theme(): { mode: "dark" | "light" };
  onTheme(callback: () => void): void;
  on<K extends keyof (HTMLElementEventMap & DocumentEventMap & WindowEventMap)>(
    target: EventTarget, type: K, callback: (event: (HTMLElementEventMap & DocumentEventMap & WindowEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  later(ms: number, callback: () => void): void;
}

type Panel = "speed" | "usage";

const layoutRefreshMs = 300;
const openPanelRefreshMs = 100;
const refreshFeedbackMs = 3_000;
const composerBodySelector = "[data-composer-body]";
const composerFooterSelector = "[data-composer-footer-responsive], [data-composer-rows]";

function mount(ctx: EffectContext) {
  if (ctx.host !== "codex") return;
  const sessions = new Map<string, NativeChatSpeed>();
  const reportedUsage = new Map<string, NativeChatUsage>();
  const activity = new NativeChatActivity();
  const desktopReader = new NativeDashboardReader((ms, callback) => ctx.later(ms, callback));
  const refreshSequence = { speed: 0, usage: 0 };
  let manualAccount: AccountSnapshot | null = null;
  let displayedId: string | null = null;
  let encoder: Tiktoken | null = null;
  let pinned: Panel | null = null;
  let openSequence = 0;
  let openPanel: Panel | null = null;
  let placement = "";
  let statisticsThread: string | null = null;

  const root = document.createElement("div");
  root.setAttribute("data-codex-usage-preview", "");
  root.hidden = true;
  root.innerHTML = `
    <button type="button" class="cup-trigger" data-speed-trigger aria-label="吐字速度" aria-expanded="false" aria-controls="cup-panel">
      <span class="cup-trigger-icon cup-speed-icon" aria-hidden="true"></span>
      <span class="cup-trigger-value"><strong data-speed-button-value>—</strong> <span>tok/s</span></span>
    </button>
    <section class="cup-card" id="cup-panel" aria-label="正文输出速度" hidden>
      <div class="cup-head cup-card-heading">
        <span>正文输出速度</span>
        <div class="cup-head-actions">
          <span class="cup-status" data-speed-status></span>
          <button type="button" class="cup-refresh" aria-label="刷新测速" title="刷新测速"><span class="cup-refresh-icon" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="cup-speed-summary">
        <div class="cup-current">
          <div class="cup-current-label" data-speed-current-label>当前</div>
          <div><strong data-speed-current>—</strong><span class="cup-unit">tok/s</span></div>
        </div>
        <div class="cup-trend">
          <canvas data-speed-chart role="img" aria-label="最近的速度采样，单位 Token 每秒" hidden></canvas>
          <span data-speed-chart-empty>等待采样</span>
        </div>
      </div>
      <dl class="cup-stats">
        <div><dt>会话平均</dt><dd><strong data-speed-average>—</strong><span class="cup-unit">tok/s</span></dd></div>
        <div><dt>会话峰值</dt><dd><strong data-speed-peak>—</strong><span class="cup-unit">tok/s</span></dd></div>
      </dl>
      <p class="cup-note"><span data-card-note data-speed-note></span><span data-refresh-status role="status" hidden></span></p>
    </section>
    <button type="button" class="cup-trigger" data-usage-trigger aria-label="用量速览" aria-expanded="false" aria-controls="cup-usage-panel">
      <span class="cup-trigger-icon cup-usage-icon" aria-hidden="true"></span>
      <span class="cup-trigger-value"><span data-usage-button-total>—</span><span class="cup-usage-unit"> tok</span> / <strong data-usage-button-cache>—</strong></span>
    </button>
    <section class="cup-card" id="cup-usage-panel" aria-label="用量速览" hidden>${usagePanelContent}</section>
    ${usageStatisticsMarkup}`;
  const buttons = {
    speed: root.querySelector<HTMLButtonElement>("[data-speed-trigger]")!,
    usage: root.querySelector<HTMLButtonElement>("[data-usage-trigger]")!,
  };
  const cards = {
    speed: root.querySelector<HTMLElement>("#cup-panel")!,
    usage: root.querySelector<HTMLElement>("#cup-usage-panel")!,
  };
  const refreshButtons = {
    speed: cards.speed.querySelector<HTMLButtonElement>(".cup-refresh")!,
    usage: cards.usage.querySelector<HTMLButtonElement>(".cup-refresh")!,
  };
  const statisticsButton = cards.usage.querySelector<HTMLButtonElement>("[data-open-statistics]")!;
  const statisticsDialog = root.querySelector<HTMLDialogElement>(".cup-statistics-dialog")!;
  const closeStatistics = statisticsDialog.querySelector<HTMLButtonElement>("[data-statistics-close]")!;
  const statistics = bindUsageStatistics(statisticsDialog, desktopReader, ctx);
  const panels = ["speed", "usage"] as const;
  const triggerValue = root.querySelector<HTMLElement>("[data-speed-button-value]")!;
  const status = root.querySelector<HTMLElement>("[data-speed-status]")!;
  const currentLabel = root.querySelector<HTMLElement>("[data-speed-current-label]")!;
  const current = root.querySelector<HTMLElement>("[data-speed-current]")!;
  const average = root.querySelector<HTMLElement>("[data-speed-average]")!;
  const peak = root.querySelector<HTMLElement>("[data-speed-peak]")!;
  const note = root.querySelector<HTMLElement>("[data-speed-note]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-speed-chart]")!;
  const chartEmpty = root.querySelector<HTMLElement>("[data-speed-chart-empty]")!;
  const renderUsage = bindUsagePreview(cards.usage, root);
  ctx.layer.append(root);
  ctx.style(`${style}\n${statisticsStyle}`);

  const format = (value: number | null | undefined) => value == null ? "—" : `≈${value.toFixed(1)}`;

  function write(element: HTMLElement, text: string) {
    if (element.textContent !== text) element.textContent = text;
  }

  function currentChatId(composer: HTMLElement | null) {
    if (!composer || composer.closest(homeComposerSelector) || composer.querySelector(pendingComposerMarker)) return null;
    // A new chat's sidebar row can keep its temporary ID after the first turn.
    const portal = composer.querySelector<HTMLElement>("[data-above-composer-conversation-id]");
    const id = sessionIdFromSidebar(portal?.dataset.aboveComposerConversationId
      ?? document.querySelector(ctx.selectors.activeThread)?.getAttribute("data-app-action-sidebar-thread-id")
      ?? null);
    return id && localChatId.test(id) ? id.toLowerCase() : null;
  }

  function syncActiveChat(composer = currentComposer(document, ctx.selectors.composer)) {
    const id = currentChatId(composer);
    if (displayedId !== id) showRefreshStatus("speed", "");
    displayedId = id;
    if (statisticsDialog.open && statisticsThread !== id) statisticsDialog.close();
    const speed = displayedId ? speedFor(displayedId) : null;
    if (speed?.key) {
      if (root.dataset.usageKey !== speed.key) root.dataset.usageKey = speed.key;
    } else {
      delete root.dataset.usageKey;
    }
    return speed?.metrics;
  }

  function speedFor(id: string) {
    const existing = sessions.get(id);
    if (existing) return existing;
    const speed = new NativeChatSpeed(id);
    sessions.set(id, speed);
    void speed.ready.then(() => {
      if (displayedId === id && root.isConnected) render();
    });
    for (const [oldId, oldSpeed] of sessions) {
      if (sessions.size <= speedHistoryLimit) break;
      if (oldId !== displayedId && oldId !== id && !oldSpeed.hasReply) sessions.delete(oldId);
    }
    return speed;
  }

  function countTokens(fragment: string) {
    encoder ??= new Tiktoken(ranks);
    return encoder.encode(fragment, [], []).length;
  }

  function finishAllSpeed() {
    for (const speed of sessions.values()) void speed.ready.then(() => speed.finish());
  }

  function showRefreshStatus(panel: Panel, message: string, temporary = false) {
    const sequence = ++refreshSequence[panel];
    const feedback = cards[panel].querySelector<HTMLElement>("[data-refresh-status]")!;
    const defaultNote = cards[panel].querySelector<HTMLElement>("[data-card-note]");
    if (defaultNote) defaultNote.hidden = !!message;
    feedback.hidden = !message;
    write(feedback, message);
    if (temporary) ctx.later(refreshFeedbackMs, () => {
      if (refreshSequence[panel] === sequence) showRefreshStatus(panel, "");
    });
  }

  async function refreshSpeed() {
    syncActiveChat();
    const id = displayedId;
    const speed = id ? sessions.get(id) : undefined;
    await speed?.ready;
    if (!root.isConnected) return;
    syncActiveChat();
    if (displayedId !== id) return;

    speed?.reloadHistory();
    showRefreshStatus("speed", speed?.metrics.recent().length ? "测速已刷新" : "已刷新 · 暂无测速样本", true);
    render();
  }

  async function refreshUsage() {
    const button = refreshButtons.usage;
    if (button.getAttribute("aria-busy") === "true") return;
    render();
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    showRefreshStatus("usage", "正在查询账户数据…");

    const account = await desktopReader.readAccount().catch(() => null);
    if (!root.isConnected) return;
    button.removeAttribute("aria-busy");
    button.removeAttribute("aria-disabled");
    if (account) manualAccount = keepLatestAccount(account, manualAccount);
    const quotaReady = account?.quota.status === "ready";
    const usageReady = account?.usage.status === "ready";
    const feedback = quotaReady && usageReady ? "账户数据已刷新"
      : quotaReady || usageReady ? "部分账户数据已刷新"
      : "本地用量已刷新。账户数据暂不可用。";
    showRefreshStatus("usage", feedback, true);
    render();
  }

  function openStatistics() {
    syncActiveChat();
    const id = displayedId;
    if (statisticsDialog.open) return;
    statisticsThread = id;
    close();
    statisticsDialog.showModal();
    statistics.open(id);
  }

  function desktopShowsActiveTurn(composer: HTMLElement | null) {
    const runningSelector = ctx.selectors.runningThread;
    const row = displayedId && runningSelector ? document.querySelector(ctx.selectors.activeThread) : null;
    if (row?.matches(runningSelector)) return true;
    const stop = composer?.querySelector('button[aria-label="Stop"], button[aria-label="停止"]');
    return Boolean(stop?.getClientRects().length);
  }

  function render() {
    const now = performance.now();
    const composer = currentComposer(document, ctx.selectors.composer);
    const session = syncActiveChat(composer);
    const styles = getComputedStyle(root);
    const chatData = styles.getPropertyValue(chatProperty).trim();
    const native = displayedId ? reportedUsage.get(displayedId) ?? null : null;
    const snapshot = session?.read(now);
    const samples = session?.recent() ?? [];
    const liveRate = snapshot?.current ?? 0;
    const recent = samples.at(-1)?.rate;
    const buttonRate = liveRate > 0 ? liveRate : recent;
    write(triggerValue, buttonRate?.toFixed(1) ?? "—");
    const speedLabel = buttonRate == null ? "吐字速度" : `吐字速度，${liveRate > 0 ? "当前" : "最近"} ${buttonRate.toFixed(1)} Token 每秒`;
    if (buttons.speed.getAttribute("aria-label") !== speedLabel) buttons.speed.setAttribute("aria-label", speedLabel);
    renderUsage(chatData, styles, native, manualAccount);
    if (openPanel !== "speed") return;
    write(currentLabel, !snapshot?.streaming && recent != null ? "最近" : "当前");
    write(current, format(snapshot?.streaming ? snapshot.current : recent));
    write(average, format(snapshot?.average));
    write(peak, format(snapshot?.peak));
    const active = displayedId ? activity.label(displayedId) : null;
    const outputStatus = snapshot?.streaming ? (snapshot.current == null ? "采样中" : "输出中") : null;
    write(status, outputStatus ?? active ?? (desktopShowsActiveTurn(composer) ? "处理中" : "未在输出"));
    write(note, samples.length ? "按正文估算 · 每次采样最长 1 秒"
      : snapshot?.streaming ? "正在采集正文输出" : "本会话暂无测速样本。回复输出时自动记录。");
    canvas.hidden = samples.length === 0;
    chartEmpty.hidden = !canvas.hidden;
    if (!canvas.hidden) drawSpeedChart(canvas, samples);
  }

  function layout() {
    const composer = currentComposer(document, ctx.selectors.composer);
    const body = composer?.matches(composerBodySelector) ? composer : composer?.querySelector<HTMLElement>(composerBodySelector);
    const footers = [...(composer?.querySelectorAll<HTMLElement>(composerFooterSelector) ?? [])].filter(visibleComposerElement);
    const footer = footers.find((node) => body?.contains(node)) ?? footers[0];
    const surface = body && (!footer || body.contains(footer)) ? body : footer;
    if (!surface) {
      root.hidden = true;
      close();
      return;
    }
    const frame = surface.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    const controls = [...surface.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="combobox"], [role="img"][aria-label], svg[aria-label]',
    )].map((node) => node.getBoundingClientRect()).filter((box) => box.height >= 16 && box.width >= 8);
    const rowBottom = controls.filter((box) => box.bottom < frame.bottom + 3)
      .reduce((bottom, box) => Math.max(bottom, box.bottom), -Infinity);
    const rowY = footerRect && footerRect.height >= 24 && footerRect.height <= 60
      ? (footerRect.top + footerRect.bottom) / 2 : rowBottom - 14;
    const slot = composerSlot(frame, controls, rowY);
    if (!slot || slot.top < 0 || slot.top + 30 > window.innerHeight) {
      root.hidden = true;
      close();
      return;
    }
    const above = slot.top - 16;
    const below = window.innerHeight - slot.top - 46;
    const openBelow = above < 320 && below > above;
    const nextPlacement = [slot.left, slot.top, slot.speedWidth, slot.usageWidth, window.innerWidth, above, below].join(",");
    if (nextPlacement !== placement) {
      placement = nextPlacement;
      root.style.left = `${slot.left}px`;
      root.style.top = `${slot.top}px`;
      buttons.speed.style.width = `${slot.speedWidth}px`;
      buttons.usage.style.width = `${slot.usageWidth}px`;
      buttons.speed.classList.toggle("cup-compact", slot.speedWidth < 40);
      buttons.usage.classList.toggle("cup-compact", slot.usageWidth < 40);
      buttons.usage.classList.toggle("cup-short", slot.usageWidth < 134);
      buttons.usage.hidden = slot.usageWidth === 0;
      if (buttons.usage.hidden && openPanel === "usage") close();
      root.toggleAttribute("data-open-below", openBelow);
      root.style.setProperty("--cup-card-space", `${Math.max(0, openBelow ? below : above)}px`);
      const edges = { speed: slot.speedWidth, usage: slot.speedWidth + buttonGap + slot.usageWidth };
      for (const panel of panels) {
        const width = Math.min(panel === "speed" ? 314 : 348, window.innerWidth - 16);
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, slot.left + edges[panel] - width));
        cards[panel].style.left = `${left - slot.left}px`;
        cards[panel].style.width = `${width}px`;
      }
    }
    root.hidden = false;
  }

  function open(panel: Panel) {
    if (root.hidden || buttons[panel].hidden) return;
    ++openSequence;
    if (pinned !== panel) pinned = null;
    show(panel);
    render();
  }

  function show(active: Panel | null) {
    openPanel = active;
    for (const panel of panels) {
      buttons[panel].setAttribute("aria-expanded", String(panel === active));
      cards[panel].hidden = panel !== active;
    }
  }

  function close() {
    ++openSequence;
    pinned = null;
    show(null);
  }

  function scheduleClose() {
    if (pinned || !openPanel) return;
    const sequence = ++openSequence;
    ctx.later(180, () => {
      const focused = document.activeElement;
      const keyboardFocusInside = focused && root.contains(focused) && focused.matches(":focus-visible");
      if (sequence === openSequence && !pinned && !root.matches(":hover") && !keyboardFocusInside) close();
    });
  }

  function setTheme() {
    root.dataset.theme = ctx.theme().mode;
  }

  ctx.on(document, "keydown", (event) => {
    if (event.key === "Escape" && openPanel) close();
  }, { capture: true });
  ctx.on(document, "pointerdown", (event) => {
    if (openPanel && event.target instanceof Node && !root.contains(event.target)) close();
  }, { capture: true });
  ctx.on(root, "pointerleave", scheduleClose);
  ctx.on(root, "focusout", scheduleClose);
  for (const panel of panels) {
    const button = buttons[panel];
    ctx.on(button, "pointerenter", () => open(panel));
    ctx.on(button, "focus", () => open(panel));
    ctx.on(button, "click", () => {
      if (pinned === panel) close();
      else {
        pinned = panel;
        open(panel);
      }
    });
  }
  ctx.on(refreshButtons.speed, "click", () => { void refreshSpeed(); });
  ctx.on(refreshButtons.usage, "click", () => { void refreshUsage(); });
  ctx.on(statisticsButton, "click", openStatistics);
  ctx.on(closeStatistics, "click", () => statisticsDialog.close());
  ctx.on(statisticsDialog, "close", () => {
    if (statisticsDialog.open) return;
    const returnToUsage = statisticsThread === displayedId;
    statisticsThread = null;
    statistics.close();
    if (returnToUsage && root.isConnected && !root.hidden) {
      buttons.usage.focus({ preventScroll: true });
      open("usage");
    }
  });
  ctx.on(window, "pagehide", finishAllSpeed);
  ctx.on(window, "message", (event) => {
    // Codex preload delivers these notifications directly to the main window.
    const legacyEnvelope = event.origin === "" && event.source === null;
    const sameWindowEnvelope = event.origin === window.location.origin && event.source === window;
    if (!legacyEnvelope && !sameWindowEnvelope) return;
    const message = event.data;
    if (message?.hostId !== "local") return;
    if (message.type === "mcp-response") {
      desktopReader.accept(message.message);
      return;
    }
    if (message.type !== "mcp-notification") return;
    const { method, params } = message;
    const rawId = typeof params?.threadId === "string" ? params.threadId : null;
    const threadId = sessionIdFromSidebar(rawId);
    if (!threadId || !localChatId.test(threadId)) return;
    const id = threadId.toLowerCase();
    if (method === "thread/tokenUsage/updated") {
      const usage = nativeChatUsage(message, rawId);
      if (!usage) return;
      // A first usage notice can arrive before the new chat's composer is mounted.
      reportedUsage.delete(id);
      reportedUsage.set(id, usage);
      if (reportedUsage.size > 96) {
        const oldest = reportedUsage.keys().next().value;
        if (oldest) reportedUsage.delete(oldest);
      }
      if (id === displayedId) render();
      return;
    }
    activity.receive(id, method, params);
    const beginsReply = method === "item/agentMessage/delta"
      || method === "item/started" && params.item?.type === "agentMessage";
    const endsReply = method === "turn/completed"
      || method === "item/completed" && params.item?.type === "agentMessage";
    if (!beginsReply && !endsReply) return;

    // Capture by the notification's thread, even if the composer has moved to another chat.
    const speed = beginsReply ? speedFor(id) : sessions.get(id);
    const at = performance.now();
    if (speed) void speed.ready.then(() => speed.receive({ method, params }, at, countTokens));
  });
  ctx.onTheme(setTheme);

  setTheme();
  layout();
  render();
  const layoutTimer = window.setInterval(() => {
    if (!document.hidden) {
      layout();
      if (!openPanel) render();
    }
  }, layoutRefreshMs);
  const panelTimer = window.setInterval(() => {
    if (openPanel && !document.hidden) render();
  }, openPanelRefreshMs);
  return {
    // Woodfish updates the appearance CSS variables without remounting the cards.
    update() {},
    dispose() {
      finishAllSpeed();
      desktopReader.dispose();
      window.clearInterval(layoutTimer);
      window.clearInterval(panelTimer);
      root.remove();
    },
  };
}

module.exports = mount;
