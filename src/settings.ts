import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { UsageStore } from "./usage-store.ts";

export function dashboardProfile(bundleDirectory: string) {
  // Codex can omit CODEX_HOME from the MCP subprocess environment.
  const cacheDirectory = resolve(bundleDirectory, "../../..");
  const pluginsDirectory = dirname(cacheDirectory);
  if (basename(cacheDirectory) === "cache" && basename(pluginsDirectory) === "plugins") {
    return dirname(pluginsDirectory);
  }
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function openUsageStore(profile: string) {
  const dataDirectory = join(profile, "codex-context-dashboard");
  try {
    mkdirSync(dataDirectory, { recursive: true });
    return new UsageStore(join(dataDirectory, "usage.sqlite"));
  } catch {
    return null;
  }
}
