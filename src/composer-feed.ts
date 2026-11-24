import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AccountService } from "./account.ts";
import { accountProperty, chatProperty, encodeSnapshot, previewSelector } from "./composer-contract.ts";
import type { AccountSnapshot, SessionTotals } from "./dashboard-types.ts";
import type { ChatLocation } from "./usage-store.ts";

const refreshInterval = 60_000;
const chatLimit = 96;
const chatKey = /^[a-f0-9]{64}$/;

function readOptional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// The companion effect uses Woodfish's documented stylesheet channel, scoped to Codex.
export function composerFeedFile() {
  const roaming = process.env.APPDATA;
  const effects = process.env.WOODFISH_EFFECTS_DIR || (roaming && join(roaming, "Woodfish", "effects"));
  if (!effects) return null;
  const data = join(effects, "codex-usage-preview-data");
  try {
    const manifest = JSON.parse(readFileSync(join(data, "effect.json"), "utf8"));
    if (manifest.name !== "用量速览数据" || manifest.hosts?.join(",") !== "codex") return null;
    for (const folder of [data, join(effects, "codex-usage-preview")]) {
      const params = readOptional(join(folder, "params.json"));
      if (params !== null && JSON.parse(params).enabled === false) return null;
    }
  } catch {
    return null;
  }
  return join(data, "effect.css");
}

export class ComposerFeed {
  private readonly db: DatabaseSync;
  private readonly file: string;
  private readonly readTotals: (location: ChatLocation) => SessionTotals;

  constructor(db: DatabaseSync, file: string, readTotals: (location: ChatLocation) => SessionTotals) {
    this.db = db;
    this.file = file;
    this.readTotals = readTotals;
    db.exec(`
      CREATE TABLE IF NOT EXISTS composer_preview (
        workspace TEXT NOT NULL,
        key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        value TEXT,
        PRIMARY KEY (workspace, key)
      ) STRICT
    `);
  }

  updateChat(location: ChatLocation) {
    if (!chatKey.test(location.chat)) return;
    this.#update(() => {
      this.#save(location.workspace, location.chat, this.readTotals(location));
      this.db.prepare(`
        DELETE FROM composer_preview WHERE length(key) = 64 AND (workspace, key) NOT IN (
          SELECT workspace, key FROM composer_preview WHERE length(key) = 64
          ORDER BY updated_at DESC, key, workspace LIMIT ?
        )
      `).run(chatLimit);
    });
  }

  claimAccountRefresh(now = Date.now()) {
    const result = this.db.prepare(`
      INSERT INTO composer_preview (workspace, key, updated_at) VALUES ('', 'refresh', ?)
      ON CONFLICT (workspace, key) DO UPDATE SET updated_at = excluded.updated_at
      WHERE composer_preview.updated_at <= ? OR composer_preview.updated_at > excluded.updated_at
    `).run(now, now - refreshInterval);
    return Number(result.changes) > 0;
  }

  updateAccount(snapshot: AccountSnapshot) {
    this.#update(() => {
      const previous = this.#readAccount();
      const choose = <T extends { updatedAt: number | null }>(next: T, old: T | undefined) =>
        old && (old.updatedAt ?? -1) > (next.updatedAt ?? -1) ? old : next;
      this.#save("", "account", {
        quota: choose(snapshot.quota, previous?.quota),
        usage: choose(snapshot.usage, previous?.usage),
      });
    });
  }

  #readAccount() {
    // Older versions cached these account-level numbers under the original workspace key.
    const latest = this.db.prepare(`
      SELECT value FROM composer_preview WHERE key = 'account' AND value IS NOT NULL
      ORDER BY (workspace = '') DESC, updated_at DESC LIMIT 1
    `).get()?.value;
    return typeof latest === "string" ? JSON.parse(latest) as AccountSnapshot : undefined;
  }

  #save(workspace: string, key: string, value: SessionTotals | AccountSnapshot) {
    this.db.prepare(`
      INSERT INTO composer_preview (workspace, key, updated_at, value) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace, key) DO UPDATE SET updated_at = excluded.updated_at, value = excluded.value
    `).run(workspace, key, Date.now(), JSON.stringify(value));
  }

  #update(change: () => void) {
    // Serialize the derived stylesheet with the matching rows when hook processes overlap.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      change();
      const rows = this.db.prepare(`
        SELECT key, value FROM composer_preview WHERE length(key) = 64 AND value IS NOT NULL
        GROUP BY key HAVING COUNT(*) = 1 ORDER BY key
      `).all();
      const rules: string[] = [];
      const account = this.#readAccount();
      if (account) rules.push(`${previewSelector} { ${accountProperty}: ${encodeSnapshot(account)}; }`);
      for (const { key, value } of rows) {
        if (chatKey.test(String(key))) {
          const data = encodeSnapshot(JSON.parse(String(value)));
          rules.push(`${previewSelector}[data-usage-key="${key}"] { ${chatProperty}: ${data}; }`);
        }
      }
      const stylesheet = rules.join("\n") + "\n";
      if (stylesheet !== readOptional(this.file)) {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, stylesheet, { encoding: "utf8", flag: "wx" });
        try { renameSync(temporary, this.file); } finally { rmSync(temporary, { force: true }); }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function refreshComposerAccount(feed: ComposerFeed, profile: string) {
  if (feed.claimAccountRefresh()) feed.updateAccount(await new AccountService({ profile }).snapshot());
}
