import { asRecord, parseAccountSnapshot, QUOTA_METHOD, USAGE_METHOD, type AccountReadMethod } from "../src/account-data.ts";
import { dashboardServerName, usageStatisticsUri } from "../src/composer-contract.ts";
import type { UsageStatistics } from "../src/dashboard-types.ts";

type DashboardRequest =
  | { method: AccountReadMethod; params?: { excludeResetCreditDetails: true } }
  | { method: "mcpServer/resource/read"; params: { server: typeof dashboardServerName; uri: string } };

type DesktopBridge = {
  sendMessageFromView(message: {
    type: "mcp-request";
    hostId: "local";
    request: DashboardRequest & { id: string };
  }): Promise<void>;
};

const readTimeoutMs = 12_000;

export class NativeDashboardReader {
  readonly #later: (ms: number, callback: () => void) => void;
  readonly #pending = new Map<string, (value: unknown) => void>();

  constructor(later: (ms: number, callback: () => void) => void) {
    this.#later = later;
  }

  async readAccount() {
    const [quota, usage] = await Promise.all([
      this.#request({ method: QUOTA_METHOD, params: { excludeResetCreditDetails: true } }),
      this.#request({ method: USAGE_METHOD }),
    ]);
    return parseAccountSnapshot(quota, usage, Date.now());
  }

  async readStatistics(year: number, target = "local"): Promise<UsageStatistics | null> {
    const uri = usageStatisticsUri(year, target);
    // A resource read without thread routing uses the installed plugin rather than the chat's cached tools.
    const reply = asRecord(await this.#request({
      method: "mcpServer/resource/read", params: { server: dashboardServerName, uri },
    }));
    const contents = reply?.contents;
    if (!Array.isArray(contents)) return null;
    const entry = contents.map(asRecord).find((value) => value?.uri === uri);
    if (typeof entry?.text !== "string") return null;
    try {
      const statistics = asRecord(JSON.parse(entry.text));
      if (statistics?.year !== year || typeof statistics.today !== "string" || !Array.isArray(statistics.days)
        || !asRecord(statistics.totals)) return null;
      return statistics as unknown as UsageStatistics;
    } catch {
      return null;
    }
  }

  accept(message: unknown) {
    const response = asRecord(message);
    if (typeof response?.id === "string") {
      this.#pending.get(response.id)?.(response.error == null ? response.result : null);
    }
  }

  dispose() {
    for (const finish of this.#pending.values()) finish(null);
  }

  #request(request: DashboardRequest): Promise<unknown> {
    const bridge = (window as Window & { electronBridge?: DesktopBridge }).electronBridge;
    if (typeof bridge?.sendMessageFromView !== "function" || !globalThis.crypto?.randomUUID) return Promise.resolve(null);
    const id = `codex-usage-preview:${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const finish = (value: unknown) => {
        if (this.#pending.delete(id)) resolve(value);
      };
      this.#pending.set(id, finish);
      this.#later(readTimeoutMs, () => finish(null));
      void Promise.resolve().then(() => {
        if (!this.#pending.has(id)) return;
        return bridge.sendMessageFromView({
          type: "mcp-request", hostId: "local",
          request: { id, ...request },
        });
      }).catch(() => finish(null));
    });
  }
}
