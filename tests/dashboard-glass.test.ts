import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { DashboardGlass } from "../composer/dashboard-glass.ts";

const origin = "https://mcp-registration-abcd.web-sandbox.oaiusercontent.com";
const shellAttribute = "data-codex-usage-dashboard-glass";
const appAttribute = "data-woodfish-glass";

class Attributes extends EventTarget {
  #values = new Map<string, string>();
  getAttribute(name: string) { return this.#values.get(name) ?? null; }
  hasAttribute(name: string) { return this.#values.has(name); }
  setAttribute(name: string, value: string) { this.#values.set(name, value); }
  removeAttribute(name: string) { this.#values.delete(name); }
}

class DashboardView extends Attributes {
  parentElement = new Attributes();
  app = new Attributes();
  legacy = false;
  legacySheet: { textContent: string; remove: () => void } | null = null;
  calls = 0;
  url = `${origin}/?app=skybridge`;
  beforeScript = async () => {};

  constructor(title = "Codex Usage Dashboard MCP 打开用量看板") {
    super();
    this.parentElement.setAttribute("data-mcp-app-origin-generated", origin);
    this.setAttribute("title", title);
    this.setAttribute("src", this.url);
  }

  getURL() { return this.url; }

  async executeJavaScript(script: string) {
    this.calls++;
    await this.beforeScript();
    const doc = {
      documentElement: this.app,
      querySelector: (selector: string) => selector.startsWith("style") ? this.legacySheet : this.legacy,
      createElement: () => ({ textContent: "", remove: () => { this.legacySheet = null; }, setAttribute() {} }),
      head: { append: (sheet: DashboardView["legacySheet"]) => { this.legacySheet = sheet; } },
    };
    return runInNewContext(script, {
      document: { querySelector: () => ({ contentDocument: doc }) },
    });
  }

  get element() { return this as unknown as Element; }
}

test("paints the host only after the matching dashboard guest is ready and detaches on navigation", async () => {
  const glass = new DashboardGlass();
  const view = new DashboardView();
  glass.sync([view.element]);
  await setImmediate();
  assert.equal(view.parentElement.hasAttribute(shellAttribute), false);

  view.app.setAttribute("data-codex-usage-dashboard", "");
  glass.sync([view.element]);
  await setImmediate();
  assert.equal(view.parentElement.getAttribute(shellAttribute), view.app.getAttribute(appAttribute));
  assert.equal(view.parentElement.hasAttribute(shellAttribute), true);
  glass.sync([view.element]);
  assert.equal(view.calls, 2);

  view.url = "https://example.test/";
  view.app = new Attributes();
  view.dispatchEvent(new Event("dom-ready"));
  glass.sync([view.element]);
  await setImmediate();
  assert.equal(view.parentElement.hasAttribute(shellAttribute), false);
  assert.equal(view.calls, 2);
  glass.dispose();
});

test("themes an already open dashboard from a cached HTML resource and removes the compatibility stylesheet", async () => {
  const css = ":root {--cup-bg: blue}";
  const glass = new DashboardGlass(css);
  const view = new DashboardView();
  view.legacy = true;
  glass.sync([view.element]);
  await setImmediate();
  assert.equal(view.legacySheet?.textContent, css);
  assert.equal(view.parentElement.hasAttribute(shellAttribute), true);
  assert.equal(view.app.hasAttribute(appAttribute), true);

  glass.dispose();
  await setImmediate();
  assert.equal(view.legacySheet, null);
  assert.equal(view.app.hasAttribute(appAttribute), false);
});

test("ignores other MCP apps and cannot leave a late update active after disposal", async () => {
  const glass = new DashboardGlass();
  const other = new DashboardView("Another MCP App");
  const wrongOrigin = new DashboardView();
  wrongOrigin.parentElement.setAttribute("data-mcp-app-origin-generated", "https://example.test");
  const view = new DashboardView();
  view.app.setAttribute("data-codex-usage-dashboard", "");
  let release!: () => void;
  view.beforeScript = () => new Promise<void>(resolve => { release = resolve; });
  glass.sync([other.element, wrongOrigin.element, view.element]);
  assert.equal(other.calls, 0);
  assert.equal(wrongOrigin.calls, 0);
  assert.equal(view.calls, 1);

  glass.dispose();
  view.beforeScript = async () => {};
  release();
  await setImmediate();
  assert.equal(view.parentElement.hasAttribute(shellAttribute), false);
  assert.equal(view.app.hasAttribute(appAttribute), false);
});
