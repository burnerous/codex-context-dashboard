type ItemActivity = "reasoning" | "tool";
type WaitingFlag = "waitingOnApproval" | "waitingOnUserInput";

interface ActiveTurn {
  id: string | null;
  items: Map<string, ItemActivity>;
  waiting: WaitingFlag | null;
}

interface ActivityParams {
  turn?: { id?: unknown };
  status?: { type?: unknown; activeFlags?: unknown };
  turnId?: unknown;
  itemId?: unknown;
  item?: { type?: unknown; id?: unknown };
}

const toolItems = new Set([
  "commandExecution", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "fileChange", "imageGeneration",
]);

export class NativeChatActivity {
  readonly #threads = new Map<string, ActiveTurn>();

  receive(threadId: string, method: string, params: ActivityParams) {
    const current = this.#threads.get(threadId);
    if (method === "thread/status/changed") {
      const type = params.status?.type;
      if (type === "active") {
        const active = current ?? this.#start(threadId, null);
        const flags = Array.isArray(params.status?.activeFlags) ? params.status.activeFlags : [];
        active.waiting = flags.includes("waitingOnApproval") ? "waitingOnApproval"
          : flags.includes("waitingOnUserInput") ? "waitingOnUserInput" : null;
      } else if (type === "idle" || type === "systemError" || type === "notLoaded") {
        this.#threads.delete(threadId);
      }
      return;
    }

    if (method === "turn/started" || method === "turn/completed") {
      const turnId = params.turn?.id;
      if (typeof turnId !== "string") return;
      if (method === "turn/started") {
        if (current?.id !== turnId) this.#start(threadId, turnId);
      } else if (current && (current.id === null || current.id === turnId)) {
        this.#threads.delete(threadId);
      }
      return;
    }

    if (method === "item/completed") {
      const itemId = params.item?.id;
      if (current && current.id === params.turnId && typeof itemId === "string") current.items.delete(itemId);
      return;
    }

    // Use the reasoning event metadata only. Speed samples still come from agentMessage deltas.
    const reasoningEvent = method === "item/reasoning/summaryTextDelta"
      || method === "item/reasoning/summaryPartAdded" || method === "item/reasoning/textDelta";
    if (method !== "item/started" && !reasoningEvent) return;
    const itemId = reasoningEvent ? params.itemId : params.item?.id;
    const itemType = reasoningEvent ? "reasoning" : params.item?.type;
    const turnId = params.turnId;
    if (typeof itemId !== "string" || typeof itemType !== "string" || typeof turnId !== "string") return;
    if (itemType !== "reasoning" && !toolItems.has(itemType)) return;
    if (current && current.id !== null && current.id !== turnId) return;

    const active = current ?? this.#start(threadId, turnId);
    active.id = turnId;
    active.items.set(itemId, itemType === "reasoning" ? "reasoning" : "tool");
  }

  label(threadId: string) {
    const active = this.#threads.get(threadId);
    if (!active) return null;
    if (active.waiting === "waitingOnApproval") return "等待确认";
    if (active.waiting === "waitingOnUserInput") return "等待输入";
    const items = [...active.items.values()];
    if (items.includes("tool")) return "正在运行工具";
    if (items.includes("reasoning")) return "思考中";
    return "处理中";
  }

  #start(threadId: string, id: string | null): ActiveTurn {
    const active: ActiveTurn = { id, items: new Map(), waiting: null };
    this.#threads.set(threadId, active);
    return active;
  }
}
