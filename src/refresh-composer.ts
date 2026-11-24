import { composerFeedFile, refreshComposerAccount } from "./composer-feed.ts";
import { dashboardProfile, openUsageStore } from "./settings.ts";

async function refresh() {
  const file = composerFeedFile();
  if (!file) return;
  const profile = dashboardProfile(__dirname);
  const store = openUsageStore(profile);
  if (!store) return;
  try {
    await refreshComposerAccount(store.composerFeed(file), profile);
  } finally {
    store.close();
  }
}

void refresh().catch(() => { process.exitCode = 1; });
