import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { AccountService } from "./account.ts";
import { chatDetailsUri, usageStatisticsUri } from "./composer-contract.ts";
import { composerFeedFile } from "./composer-feed.ts";
import type { DashboardSnapshot } from "./dashboard-types.ts";
import { dashboardProfile, openUsageStore } from "./settings.ts";

const server = new McpServer(
  { name: "codex-usage-dashboard", version: "0.1.9" },
  { instructions: "用户要求打开 Codex 用量看板时，调用 open_usage_dashboard，在聊天内呈现面板。" },
);
const uri = "ui://codex-usage-dashboard/dashboard-0.1.1.html";
const profile = dashboardProfile(__dirname);
const account = new AccountService({ profile });
const store = openUsageStore(profile);

registerAppResource(server, "Codex 用量看板", uri, {}, async () => ({
  contents: [{
    uri,
    mimeType: "text/html;profile=mcp-app",
    text: await readFile(join(__dirname, "dashboard.html"), "utf8"),
  }],
}));

registerAppTool(server, "open_usage_dashboard", {
  title: "打开用量看板",
  description: "在当前聊天中打开可交互的 Codex 用量看板，显示本聊天的 Token 与缓存统计、压缩和子代理事件，以及账户额度和近期用量。",
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: uri, visibility: ["model"] } },
}, async () => ({
  structuredContent: { viewId: store?.openView() ?? randomUUID() },
  content: [{ type: "text", text: "用量看板已打开。" }],
}));

server.registerResource(
  "聊天请求和事件",
  new ResourceTemplate(chatDetailsUri("{threadId}"), { list: undefined }),
  { mimeType: "application/json", annotations: { audience: ["user"] } },
  async (resource, variables) => {
    const { data: threadId } = z.uuid().safeParse(variables.threadId);
    if (!threadId) throw new Error("Invalid local chat identifier.");
    let session: DashboardSnapshot["session"] = { status: "unavailable", totals: null, timeline: [] };
    try {
      session = store?.readChat(threadId) ?? session;
    } catch {
      // Local records can be temporarily unavailable.
    }
    return { contents: [{ uri: resource.href, mimeType: "application/json", text: JSON.stringify(session) }] };
  },
);

server.registerResource(
  "本地用量统计",
  new ResourceTemplate(usageStatisticsUri("{year}", "{target}"), { list: undefined }),
  { mimeType: "application/json", annotations: { audience: ["user"] } },
  async (resource, { year, target }) => {
    if (typeof year !== "string" || !/^[0-9]{4}$/.test(year)) throw new Error("Invalid statistics year.");
    const threadId = target === "local" ? undefined : z.uuid().safeParse(target).data;
    if (target !== "local" && !threadId) throw new Error("Invalid local chat identifier.");
    if (!store) throw new Error("Local usage statistics are unavailable.");
    const statistics = store.readUsageStatistics(Number(year), threadId);
    return { contents: [{ uri: resource.href, mimeType: "application/json", text: JSON.stringify(statistics) }] };
  },
);

registerAppTool(server, "read_dashboard", {
  title: "刷新用量看板",
  description: "读取当前看板绑定的聊天统计和可用的账户数据。",
  inputSchema: { viewId: z.uuid() },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ["app"] } },
}, async ({ viewId }) => {
  let session: DashboardSnapshot["session"] = { status: "unavailable", totals: null, timeline: [] };
  try {
    session = store?.readSession(viewId) ?? session;
  } catch {
    // Account information can still be shown while the local statistics database is unavailable.
  }
  const snapshot: DashboardSnapshot = { session, account: await account.snapshot() };
  const file = session.status !== "unavailable" && composerFeedFile();
  if (file && store) {
    try { store.composerFeed(file).updateAccount(snapshot.account); } catch {
      // The full dashboard can be used independently of the optional composer preview.
    }
  }
  return { structuredContent: { ...snapshot }, content: [] };
});

const transport = new StdioServerTransport();
void server.connect(transport).catch(() => {
  process.exitCode = 1;
});
