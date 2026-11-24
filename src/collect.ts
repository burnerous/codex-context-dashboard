import { dashboardProfile, openUsageStore } from "./settings.ts";
import { composerFeedFile, refreshComposerAccount } from "./composer-feed.ts";

async function collect() {
  const timestamp = Date.now();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) return;
    chunks.push(buffer);
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const profile = dashboardProfile(__dirname);
  const store = openUsageStore(profile);
  if (!store) return;
  try {
    const update = store.ingest(payload, timestamp);
    const file = update ? composerFeedFile() : null;
    if (update && file) {
      const feed = store.composerFeed(file);
      feed.updateChat(update);
      if (update.request) await refreshComposerAccount(feed, profile);
    }
  } finally {
    store.close();
  }
}

// A statistics collector should never steer or block the chat.
void collect().catch(() => {});
