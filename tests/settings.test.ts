import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dashboardProfile, openUsageStore } from "../src/settings.ts";

test("uses the Codex profile that owns the installed plugin bundle", () => {
  const profile = resolve(tmpdir(), "isolated-dashboard-profile");
  const installed = join(profile, "plugins", "cache", "codex-dashboard-local", "codex-context-dashboard", "0.1.1");
  assert.equal(dashboardProfile(installed), profile);
});

test("a fresh dashboard works without a workspace configuration file", () => {
  const profile = mkdtempSync(join(tmpdir(), "codex-dashboard-profile-"));
  try {
    const store = openUsageStore(profile);
    assert(store);
    try {
      const session = { cwd: join(profile, "new-workspace"), session_id: "new-chat" };
      const birth = store.ingest({ ...session, hook_event_name: "SessionStart", source: "startup" });
      assert(birth);
      assert.equal(birth.request, false);
      assert.deepEqual(store.ingest({ ...session, hook_event_name: "SessionStart", source: "resume" }), birth);
    } finally {
      store.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
