import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const market = join(root, "dist", "marketplace");
const name = "codex-context-dashboard";
const plugin = join(market, "plugins", name);

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function json(path, data) {
  await write(path, JSON.stringify(data, null, 2) + "\n");
}

const nodeExe = process.execPath;
let command = '"' + nodeExe + '" "${PLUGIN_ROOT}/collect.cjs"';
if (process.platform === "win32") {
  // A leading quoted executable is a string in a PowerShell command.
  if (/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(nodeExe)) {
    command = nodeExe + ' "${PLUGIN_ROOT}/collect.cjs"';
  } else {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    command = powershell + ' -NoProfile -NonInteractive -File "${PLUGIN_ROOT}/collect.ps1"';
    await write(join(plugin, "collect.ps1"), [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::InputEncoding",
      "[Console]::In.ReadToEnd() | & '" + nodeExe.replaceAll("'", "''") + "' (Join-Path $PSScriptRoot 'collect.cjs')",
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"));
  }
}
const hook = (background = false, timeout = 3) => ({ type: "command", command, async: background, timeout });
const bundledHooks = {
  SessionStart: [{ matcher: "^(startup|resume)$", hooks: [hook()] }],
  PostModelRequest: [{ hooks: [hook(true, 16)] }],
  PostCompact: [{ hooks: [hook()] }],
  SubagentStart: [{ hooks: [hook()] }],
  SubagentStop: [{ hooks: [hook()] }],
  PostToolUse: [{ matcher: "^mcp__[\\w-]+__open_usage_dashboard$", hooks: [hook(true)] }],
};

await mkdir(plugin, { recursive: true });
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: { server: "src/server.ts", collect: "src/collect.ts", "refresh-composer": "src/refresh-composer.ts" },
    platform: "node", target: "node24", format: "cjs", bundle: true,
    outdir: plugin, outExtension: { ".js": ".cjs" }, legalComments: "linked",
  }),
  json(join(plugin, ".mcp.json"), {
    mcpServers: { codex_usage_dashboard: { command: nodeExe, args: ["server.cjs"], cwd: "." } },
  }),
  json(join(plugin, "hooks", "hooks.json"), { hooks: bundledHooks }),
  json(join(market, ".claude-plugin", "marketplace.json"), {
    name: "codex-dashboard-local",
    interface: { displayName: "Codex 用量看板（本地）" },
    plugins: [{ name, source: "./plugins/" + name }],
  }),
  ...[".codex-plugin/plugin.json", "skills/open-usage-dashboard/SKILL.md"].map(async (file) => {
    await mkdir(dirname(join(plugin, file)), { recursive: true });
    await copyFile(join(root, "plugin", file), join(plugin, file));
  }),
]);

const [page, styles, code] = await Promise.all([
  readFile(join(root, "web", "index.html"), "utf8"),
  readFile(join(root, "web", "dashboard.css"), "utf8"),
  build({
    entryPoints: [join(root, "web", "dashboard.ts")],
    platform: "browser", target: "chrome120", format: "iife", bundle: true,
    minify: true, write: false, legalComments: "inline",
  }),
]);
const html = page
  .replace("<!-- DASHBOARD_STYLES -->", () => "<style>\n" + styles + "\n</style>")
  .replace("<!-- DASHBOARD_SCRIPT -->", () => "<script type=\"module\">\n"
    + code.outputFiles[0].text.replace(/<\/script/gi, "<\\/script") + "\n</script>");
await Promise.all([
  write(join(plugin, "dashboard.html"), html),
  write(join(root, "dist", "preview.html"), html),
]);
console.log("Built the Codex marketplace and dashboard preview.");
