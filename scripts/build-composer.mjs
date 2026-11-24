import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ranks from "js-tiktoken/ranks/o200k_base";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "woodfish", "codex-usage-preview", "effect.js");
const cutoff = ranks.bpe_ranks.lastIndexOf(" ", 420_000);
const compactRanks = { ...ranks, bpe_ranks: ranks.bpe_ranks.slice(0, cutoff) };
await mkdir(dirname(output), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["composer/effect.cts"],
  outfile: output,
  platform: "browser",
  target: "chrome120",
  format: "cjs",
  bundle: true,
  minify: true,
  legalComments: "inline",
  loader: { ".css": "text" },
  plugins: [{
    name: "compact-speed-tokenizer",
    setup(builder) {
      builder.onResolve({ filter: /^composer-speed-ranks$/ }, () => ({ path: "common-ranks", namespace: "composer-speed" }));
      builder.onLoad({ filter: /.*/, namespace: "composer-speed" }, () => ({
        contents: "export default " + JSON.stringify(compactRanks),
        loader: "js",
      }));
    },
  }],
});
if ((await stat(output)).size > 512 * 1024) throw new Error("用量速览超过 Woodfish 的 512 KB 上限。");
await copyFile(join(root, "composer", "effect.json"), join(dirname(output), "effect.json"));
const dataDirectory = join(dirname(output), "..", "codex-usage-preview-data");
await mkdir(dataDirectory, { recursive: true });
await copyFile(join(root, "composer", "data-effect.json"), join(dataDirectory, "effect.json"));
console.log("Built the Codex-only Woodfish effect.");
