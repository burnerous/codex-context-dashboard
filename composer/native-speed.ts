import { SessionSpeed } from "./speed.ts";
import { isNewerSpeedHistory, readSpeedHistory, saveSpeedHistory } from "./speed-history.ts";

interface Reply {
  id: string;
  turnId: string;
  startedAtMs: number | null;
  tokens: number;
  previousSegment: number | undefined;
}

interface SpeedNotification {
  method: string;
  params: {
    itemId?: unknown;
    turnId?: unknown;
    delta?: unknown;
    startedAtMs?: unknown;
    completedAtMs?: unknown;
    contentTokenCount?: unknown;
    item?: { id?: unknown; type?: unknown };
    turn?: { id?: unknown };
  };
}

export class NativeChatSpeed {
  key: string | null = null;
  metrics = new SessionSpeed();
  readonly ready: Promise<void>;
  #reply: Reply | null = null;

  constructor(id: string) {
    this.ready = this.#restore(id);
  }

  get hasReply() {
    return this.#reply !== null;
  }

  reloadHistory() {
    if (!this.key || this.#reply) return;
    const history = readSpeedHistory(this.key);
    if (history && isNewerSpeedHistory(history, this.metrics.history())) this.metrics = new SessionSpeed(history);
  }

  receive({ method, params }: SpeedNotification, at: number, countTokens: (fragment: string) => number) {
    if (method === "turn/completed") {
      if (this.#reply && this.#reply.turnId === params.turn?.id) this.finish();
      return;
    }

    const isDelta = method === "item/agentMessage/delta";
    const itemId = isDelta ? params.itemId : params.item?.id;
    if (typeof itemId !== "string" || typeof params.turnId !== "string"
      || (!isDelta && params.item?.type !== "agentMessage")) return;

    const reply = this.#reply?.id === itemId && this.#reply.turnId === params.turnId ? this.#reply : null;
    if (method === "item/completed") {
      if (!reply) return;
      if (!this.#sampled(reply) && reply.startedAtMs !== null && typeof params.completedAtMs === "number") {
        const nativeTokens = params.contentTokenCount;
        const tokens = typeof nativeTokens === "number" && Number.isSafeInteger(nativeTokens) && nativeTokens > 0
          ? nativeTokens : reply.tokens;
        this.metrics.addCompleted(at, params.completedAtMs - reply.startedAtMs, tokens);
      }
      this.finish();
    } else if (method === "item/started") {
      const next = reply ?? this.#start(itemId, params.turnId);
      if (typeof params.startedAtMs === "number") next.startedAtMs = params.startedAtMs;
    } else if (isDelta && typeof params.delta === "string" && params.delta) {
      const next = reply ?? this.#start(itemId, params.turnId);
      const tokens = countTokens(params.delta);
      next.tokens += tokens;
      this.metrics.add(at, tokens);
    }
  }

  finish() {
    const shouldSave = this.#reply && this.#sampled(this.#reply);
    this.#reply = null;
    this.metrics.end();
    if (!this.key || !shouldSave) return;
    const history = this.metrics.history();
    if (history) saveSpeedHistory(this.key, history);
  }

  #start(id: string, turnId: string): Reply {
    this.finish();
    this.#reply = { id, turnId, startedAtMs: null, tokens: 0, previousSegment: this.metrics.recent().at(-1)?.segment };
    return this.#reply;
  }

  #sampled(reply: Reply) {
    return this.metrics.recent().at(-1)?.segment !== reply.previousSegment;
  }

  async #restore(id: string) {
    if (!globalThis.crypto?.subtle) return;
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
      this.key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      this.reloadHistory();
    } catch {
      // Live measurements still work when the renderer cannot restore local history.
    }
  }
}
