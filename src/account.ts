import { spawn } from "node:child_process";
import { asRecord, parseAccountSnapshot, QUOTA_METHOD, USAGE_METHOD, type AccountReadMethod } from "./account-data.ts";
import type { AccountSnapshot } from "./dashboard-types.ts";
export type { AccountReadMethod } from "./account-data.ts";

const REFRESH_MS = 60_000;
const READ_TIMEOUT_MS = 12_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 2 * MAX_LINE_BYTES;

type AccountReader = (method: AccountReadMethod) => Promise<unknown>;

async function withCodexReader<T>(run: (read: AccountReader) => Promise<T>, profile?: string): Promise<T> {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const child = spawn(executable, ["app-server"], {
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: profile ? { ...process.env, CODEX_HOME: profile } : undefined,
  });
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  let failure: Error | null = null;
  let remainder: Buffer = Buffer.alloc(0);
  let bytesRead = 0;

  function abort(message: string): void {
    if (failure) return;
    failure = new Error(message);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }

  const disconnected = () => abort("Codex App Server connection closed.");
  child.once("error", disconnected);
  child.once("close", disconnected);
  child.stdin.on("error", disconnected);
  child.stdout.on("error", disconnected);
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    bytesRead += chunk.length;
    if (bytesRead > MAX_OUTPUT_BYTES) {
      abort("Codex App Server response exceeded the size limit.");
      return;
    }

    const buffer = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
    let start = 0;
    let newline = buffer.indexOf(10);
    while (newline >= 0) {
      if (newline - start > MAX_LINE_BYTES) {
        abort("Codex App Server response exceeded the line limit.");
        return;
      }
      const line = buffer.toString("utf8", start, newline).trim();
      start = newline + 1;
      newline = buffer.indexOf(10, start);
      if (line.length === 0) continue;

      let response: Record<string, unknown> | null;
      try {
        response = asRecord(JSON.parse(line));
      } catch {
        abort("Codex App Server returned invalid JSON.");
        return;
      }
      if (!response || typeof response.id !== "number" || "method" in response) continue;

      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      if ("result" in response && !("error" in response)) {
        request.resolve(response.result);
      } else {
        request.reject(new Error("Codex App Server rejected the request."));
      }
    }
    remainder = buffer.subarray(start);
    if (remainder.length > MAX_LINE_BYTES) {
      abort("Codex App Server response exceeded the line limit.");
    }
  });
  const timeout = setTimeout(() => abort("Codex App Server timed out."), READ_TIMEOUT_MS);

  function send(message: object): void {
    child.stdin.write(JSON.stringify(message) + "\n", (error) => {
      if (error) disconnected();
    });
  }

  function request(method: "initialize" | AccountReadMethod, params?: object): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  try {
    await request("initialize", {
      clientInfo: {
        name: "codex_context_dashboard",
        title: "Codex Context Dashboard",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        explicitGatewayOauth: true,
      },
    });
    if (failure) throw failure;
    send({ method: "initialized" });
    return await run((method) =>
      request(method, method === QUOTA_METHOD ? { excludeResetCreditDetails: true } : undefined)
    );
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export async function readCodexAccount(method: AccountReadMethod): Promise<unknown> {
  if (method !== QUOTA_METHOD && method !== USAGE_METHOD) {
    throw new Error("Unsupported account read method.");
  }
  return withCodexReader((read) => read(method));
}

function readBoth(read: AccountReader) {
  const invoke = async (method: AccountReadMethod) => read(method);
  return Promise.allSettled([invoke(QUOTA_METHOD), invoke(USAGE_METHOD)] as const);
}

export class AccountService {
  readonly #read: AccountReader | undefined;
  readonly #profile: string | undefined;
  readonly #now: () => number;
  #current: AccountSnapshot = {
    quota: { status: "unavailable", updatedAt: null, windows: [] },
    usage: { status: "unavailable", updatedAt: null, days: [] },
  };
  #refreshedAt: number | null = null;
  #pending: Promise<AccountSnapshot> | null = null;

  constructor({ read, now = Date.now, profile }: { read?: AccountReader; now?: () => number; profile?: string } = {}) {
    this.#read = read;
    this.#now = now;
    this.#profile = profile;
  }

  snapshot(): Promise<AccountSnapshot> {
    if (this.#pending) return this.#pending;
    if (this.#refreshedAt !== null && this.#now() - this.#refreshedAt < REFRESH_MS) {
      return Promise.resolve(this.#current);
    }
    this.#pending = this.#refresh().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(): Promise<AccountSnapshot> {
    const results = this.#read
      ? await readBoth(this.#read)
      : await withCodexReader(readBoth, this.#profile).catch(() => null);
    const quota = results?.[0];
    const usage = results?.[1];
    const updatedAt = this.#now();
    this.#current = parseAccountSnapshot(
      quota?.status === "fulfilled" ? quota.value : null,
      usage?.status === "fulfilled" ? usage.value : null,
      updatedAt,
      this.#current,
    );
    this.#refreshedAt = updatedAt;
    return this.#current;
  }
}
