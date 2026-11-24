import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ComposerFeed } from "./composer-feed.ts";
import type { DailyModelUsage, DashboardSnapshot, TimelineItem, UsageStatistics } from "./dashboard-types.ts";
import { addDays, beijingDate, mondayOf } from "./usage-calendar.ts";

const viewLifetime = 24 * 60 * 60 * 1_000;
const viewBindingGrace = 10_000;
const latestTimelineLimit = 150;
const dashboardTool = /^mcp__[\w-]+__open_usage_dashboard$/;
const viewIdPattern = /^[a-f0-9-]{36}$/;
type Session = DashboardSnapshot["session"];
type HookInput = Record<string, unknown>;

export interface ChatLocation {
  workspace: string;
  chat: string;
}

function object(value: unknown): HookInput | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as HookInput
    : undefined;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_./:-]{1,128}$/.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function workspaceKey(path: string) {
  let canonical = resolve(path);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // An unavailable workspace has no alias to resolve.
  }
  return hash(process.platform === "win32" ? canonical.toLowerCase() : canonical);
}

function eventFor(input: HookInput, timestamp: number): (TimelineItem & { totalTokens?: number | null }) | null {
  const identifierForAgent = identifier(input.agent_id);
  const agentId = identifierForAgent === null ? null : hash(identifierForAgent).slice(0, 12);
  switch (input.hook_event_name) {
    case "PostModelRequest": {
      const status = input.status;
      if (status !== "completed" && status !== "failed" && status !== "cancelled") return null;
      const usage = object(input.token_usage);
      return {
        kind: "request", timestamp, status, model: identifier(input.model), agentId,
        inputTokens: count(usage?.input_tokens),
        outputTokens: count(usage?.output_tokens),
        cachedInputTokens: count(usage?.cached_input_tokens),
        totalTokens: count(usage?.total_tokens),
      };
    }
    case "PostCompact":
      return {
        kind: "compaction", timestamp,
        trigger: input.trigger === "auto" || input.trigger === "manual" ? input.trigger : null,
      };
    case "SubagentStart":
    case "SubagentStop":
      if (agentId === null) return null;
      return {
        kind: input.hook_event_name === "SubagentStart" ? "agent-start" : "agent-stop",
        timestamp, agentId, agentType: identifier(input.agent_type),
      };
    default:
      return null;
  }
}

function emptySession(status: "waiting" | "unavailable"): Session {
  return { status, totals: null, timeline: [] };
}

function recordedTokenTotal(days: DailyModelUsage[]) {
  if (days.length === 0) return 0;
  let total: number | null = null;
  for (const day of days) {
    if (day.totalTokens !== null) total = (total ?? 0) + day.totalTokens;
  }
  return total;
}

export class UsageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 1_500 });
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS chats (
          workspace TEXT NOT NULL,
          id TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
          PRIMARY KEY (workspace, id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS chats_id ON chats (id);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          workspace TEXT NOT NULL,
          chat TEXT NOT NULL,
          time INTEGER NOT NULL,
          kind TEXT NOT NULL,
          item TEXT NOT NULL CHECK (json_valid(item)),
          FOREIGN KEY (workspace, chat) REFERENCES chats (workspace, id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS events_chat ON events (workspace, chat, time, id);
        CREATE TABLE IF NOT EXISTS views (
          id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          chat TEXT
        ) STRICT;
      `);
      this.#ensureCollectionScope();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  composerFeed(file: string) {
    return new ComposerFeed(this.db, file, (chat) => this.#readTotals(chat));
  }

  openView(now = Date.now()) {
    const viewId = randomUUID();
    this.db.prepare("DELETE FROM views WHERE opened_at < ?").run(now - viewLifetime);
    this.db.prepare("INSERT INTO views (id, workspace, opened_at) VALUES (?, '', ?)")
      .run(viewId, now);
    return viewId;
  }

  ingest(payload: unknown, now = Date.now()) {
    const input = object(payload);
    if (!input || typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return;
    const sessionId = identifier(input.session_id);
    if (!sessionId) return;
    const location = { workspace: workspaceKey(input.cwd), chat: hash(sessionId) };
    const { workspace, chat } = location;

    if (input.hook_event_name === "SessionStart") {
      if (input.source !== "startup" && input.source !== "resume") return;
      this.#registerChat(location, now, input.source === "resume");
      if (this.#hasChat(location)) return { ...location, request: false };
      return;
    }

    if (input.hook_event_name === "PostToolUse") {
      const response = object(input.tool_response);
      const viewId = object(response?.structuredContent)?.viewId;
      if (typeof input.tool_name === "string" && dashboardTool.test(input.tool_name)
          && response?.isError !== true && typeof viewId === "string" && viewIdPattern.test(viewId)) {
        const bound = this.db.prepare(`
          UPDATE views SET workspace = ?, chat = ? WHERE id = ?
            AND chat IS NULL AND opened_at >= ? AND (workspace = '' OR workspace = ?)
        `).run(workspace, chat, viewId, now - viewLifetime, workspace);
        if (Number(bound.changes) > 0 && this.#hasChat(location)) return { ...location, request: false };
      }
      return;
    }

    const item = eventFor(input, now);
    if (!item) return;
    // Capture new events in chats that were already open when this version was installed.
    this.#registerChat(location, now, true);
    const inserted = this.db.prepare(`
      INSERT INTO events (workspace, chat, time, kind, item)
      SELECT workspace, id, ?, ?, ? FROM chats WHERE workspace = ? AND id = ?
    `).run(now, item.kind, JSON.stringify(item), workspace, chat);
    if (item.kind === "request" && Number(inserted.changes) > 0) return { ...location, request: true };
  }

  readSession(viewId: string, now = Date.now()): Session {
    const view = this.db.prepare("SELECT workspace, chat, opened_at FROM views WHERE id = ?")
      .get(viewId) as { workspace: string; chat: string | null; opened_at: number } | undefined;
    if (!view || now - view.opened_at > viewLifetime) return emptySession("unavailable");
    if (view.chat === null) return emptySession(now - view.opened_at < viewBindingGrace ? "waiting" : "unavailable");
    const location = { workspace: view.workspace, chat: view.chat };
    if (!this.#hasChat(location)) return emptySession("unavailable");
    return this.#readChat(location);
  }

  readChat(sessionId: string): Session {
    const location = this.#resolveChat(sessionId);
    return typeof location === "string" ? emptySession(location) : this.#readChat(location);
  }

  readUsageStatistics(year: number, threadId?: string, now = Date.now()): UsageStatistics {
    const today = beijingDate(now);
    const empty: UsageStatistics = {
      year, today, firstDate: null, days: [],
      totals: { today: null, week: null, month: null, all: null },
    };
    const location = threadId === undefined ? null : this.#resolveChat(threadId);
    if (typeof location === "string") return empty;

    const scopeFilter = location ? "AND workspace = ? AND chat = ?" : "";
    const parameters = location ? [location.workspace, location.chat] : [];
    const rows = this.db.prepare(`
      WITH requests AS (
        SELECT date(time / 1000.0, 'unixepoch', '+08:00') AS date,
          json_extract(item, '$.model') AS model,
          json_extract(item, '$.inputTokens') AS input,
          json_extract(item, '$.cachedInputTokens') AS cached,
          json_extract(item, '$.outputTokens') AS output,
          json_extract(item, '$.totalTokens') AS total
        FROM events WHERE kind = 'request' ${scopeFilter}
      )
      SELECT date, model, SUM(CAST(total AS REAL)) AS totalTokens,
        SUM(CAST(CASE WHEN cached <= input THEN input - cached END AS REAL)) AS uncachedInputTokens,
        SUM(CAST(cached AS REAL)) AS cachedInputTokens, SUM(CAST(output AS REAL)) AS outputTokens
      FROM requests GROUP BY date, model ORDER BY date, model
    `).all(...parameters) as unknown as DailyModelUsage[];
    if (rows.length === 0) return empty;

    const weekStart = mondayOf(today);
    const weekEnd = addDays(weekStart, 7);
    const monthPrefix = today.slice(0, 7) + "-";
    const yearPrefix = String(year).padStart(4, "0") + "-";
    return {
      year, today, firstDate: rows[0].date,
      totals: {
        today: recordedTokenTotal(rows.filter((row) => row.date === today)),
        week: recordedTokenTotal(rows.filter((row) => row.date >= weekStart && row.date < weekEnd)),
        month: recordedTokenTotal(rows.filter((row) => row.date.startsWith(monthPrefix))),
        all: recordedTokenTotal(rows),
      },
      days: rows.filter((row) => row.date.startsWith(yearPrefix)).map((row) => ({ ...row })),
    };
  }

  #resolveChat(sessionId: string): ChatLocation | "waiting" | "unavailable" {
    const chat = hash(sessionId);
    const matches = this.db.prepare("SELECT workspace FROM chats WHERE id = ? LIMIT 2").all(chat);
    if (!matches.length) return "waiting";
    if (matches.length !== 1) return "unavailable";
    return { workspace: String(matches[0].workspace), chat };
  }

  #readChat(location: ChatLocation): Session {
    const rows = this.db.prepare(`
      SELECT item FROM events WHERE workspace = ? AND chat = ?
      ORDER BY time DESC, id DESC LIMIT ?
    `).all(location.workspace, location.chat, latestTimelineLimit);
    if (rows.length === 0) return emptySession("waiting");

    return {
      status: "ready",
      totals: this.#readTotals(location),
      timeline: rows.reverse().map((row) => JSON.parse(String(row.item)) as TimelineItem),
    };
  }

  #hasChat({ workspace, chat }: ChatLocation) {
    return this.db.prepare("SELECT 1 FROM chats WHERE workspace = ? AND id = ?").get(workspace, chat) !== undefined;
  }

  #registerChat({ workspace, chat }: ChatLocation, now: number, partial: boolean) {
    // Keep the original workspace even if a later hook reports a different cwd.
    this.db.prepare(`
      INSERT INTO chats (workspace, id, opened_at, partial)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chats WHERE id = ?)
    `).run(workspace, chat, now, partial ? 1 : 0, chat);
  }

  #ensureCollectionScope() {
    const hasColumn = this.db.prepare("SELECT 1 FROM pragma_table_info('chats') WHERE name = 'partial'");
    if (hasColumn.get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn.get()) this.db.exec("ALTER TABLE chats ADD COLUMN partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1))");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #readTotals({ workspace, chat }: ChatLocation) {
    const totals = this.db.prepare(`
      WITH requests AS (
        SELECT
          json_extract(item, '$.inputTokens') AS input,
          json_extract(item, '$.cachedInputTokens') AS cached,
          json_extract(item, '$.outputTokens') AS output,
          json_extract(item, '$.totalTokens') AS total
        FROM events WHERE workspace = ? AND chat = ? AND kind = 'request'
      )
      SELECT COUNT(*) AS requests, COUNT(total) AS measuredRequests,
        SUM(input) AS inputTokens, SUM(cached) AS cachedInputTokens,
        SUM(output) AS outputTokens, SUM(total) AS totalTokens,
        100.0 * SUM(CASE WHEN input > 0 AND cached <= input THEN cached END) /
          NULLIF(SUM(CASE WHEN input > 0 AND cached <= input THEN input END), 0) AS cacheHitPercent
      FROM requests
    `).get(workspace, chat) as unknown as NonNullable<Session["totals"]>;
    const partial = this.db.prepare("SELECT partial FROM chats WHERE workspace = ? AND id = ?").get(workspace, chat);
    return partial?.partial === 1 ? { ...totals, partial: true as const } : { ...totals };
  }
}
