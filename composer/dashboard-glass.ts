export const dashboardWebviewSelector = "[data-mcp-app-frame][data-mcp-app-origin-generated] > webview[title]";

const frameAttribute = "data-codex-usage-dashboard-glass";
const sandboxHost = /^mcp-registration-[a-f\d]+\.web-sandbox\.oaiusercontent\.com$/;
const maxAttempts = 20;

type DashboardWebview = Element & {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
};

interface Attachment {
  view: DashboardWebview;
  frame: Element;
  origin: string;
  token: string;
  onReady: () => void;
  revision: number;
  attempts: number;
  pending: boolean;
  active: boolean;
  detached: boolean;
}

function setGuestGlass(token: string, enabled: boolean, legacyCss: string): boolean {
  // Codex's Electron guest wraps the MCP HTML in a same-origin Skybridge iframe.
  const guest = document.querySelector<HTMLIFrameElement>("iframe#root")?.contentDocument;
  if (!guest) return false;
  const app = guest.documentElement;
  const legacy = !app.hasAttribute("data-codex-usage-dashboard");
  if (legacy && !guest.querySelector('main#dashboard.dashboard > article.surface[aria-labelledby="dashboard-title"]')) return false;
  const attribute = "data-woodfish-glass";
  const legacyStyle = guest.querySelector("style[data-woodfish-dashboard-compat]");
  if (enabled) {
    // Open chat cards can retain the resource they fetched before the plugin update.
    if (legacy && !legacyStyle) {
      const sheet = guest.createElement("style");
      sheet.setAttribute("data-woodfish-dashboard-compat", "");
      sheet.textContent = legacyCss;
      guest.head.append(sheet);
    }
    app.setAttribute(attribute, token);
  } else if (app.getAttribute(attribute) === token) {
    app.removeAttribute(attribute);
    legacyStyle?.remove();
  }
  return true;
}

async function updateGuest({ view, origin, token }: Attachment, enabled: boolean, legacyCss = ""): Promise<boolean> {
  try {
    if (new URL(view.getURL()).origin !== origin) return false;
    const result = await view.executeJavaScript(
      `(${setGuestGlass.toString()})(${JSON.stringify(token)}, ${enabled}, ${JSON.stringify(legacyCss)})`,
    );
    return result === true;
  } catch {
    // The guest may still be loading or may already have been destroyed.
    return false;
  }
}

export class DashboardGlass {
  #attachments = new Map<Element, Attachment>();
  readonly #legacyCss: string;

  constructor(legacyCss = "") {
    this.#legacyCss = legacyCss;
  }

  sync(elements: Iterable<Element>): void {
    const current = new Set<Element>();
    for (const element of elements) {
      const frame = element.parentElement;
      const source = element.getAttribute("src");
      const view = element as DashboardWebview;
      if (!element.getAttribute("title")?.endsWith("打开用量看板") || !frame || !source || !URL.canParse(source)
        || typeof view.executeJavaScript !== "function" || typeof view.getURL !== "function") continue;
      const url = new URL(source);
      if (url.protocol !== "https:" || !sandboxHost.test(url.hostname)
        || url.origin !== frame.getAttribute("data-mcp-app-origin-generated")) continue;

      current.add(view);
      let attachment = this.#attachments.get(view);
      if (attachment && (attachment.frame !== frame || attachment.origin !== url.origin)) {
        this.#detach(attachment);
        attachment = undefined;
      }
      this.#probe(attachment ?? this.#attach(view, frame, url.origin));
    }

    for (const [view, attachment] of this.#attachments) {
      if (!current.has(view)) this.#detach(attachment);
    }
  }

  dispose(): void {
    for (const attachment of this.#attachments.values()) this.#detach(attachment);
  }

  #attach(view: DashboardWebview, frame: Element, origin: string): Attachment {
    const attachment: Attachment = {
      view, frame, origin, token: crypto.randomUUID(), revision: 0, attempts: 0,
      pending: false, active: false, detached: false,
      onReady: () => {
        this.#clearFrame(attachment);
        attachment.revision++;
        attachment.attempts = 0;
        attachment.pending = false;
        attachment.active = false;
        this.#probe(attachment);
      },
    };
    view.addEventListener("dom-ready", attachment.onReady);
    this.#attachments.set(view, attachment);
    return attachment;
  }

  #probe(attachment: Attachment): void {
    if (attachment.pending || attachment.active || attachment.attempts >= maxAttempts) return;
    const revision = attachment.revision;
    attachment.pending = true;
    attachment.attempts++;
    void updateGuest(attachment, true, this.#legacyCss).then(active => {
      if (attachment.detached) {
        if (active) void updateGuest(attachment, false);
        return;
      }
      if (attachment.revision !== revision) return;
      attachment.pending = false;
      attachment.active = active;
      if (active) attachment.frame.setAttribute(frameAttribute, attachment.token);
    });
  }

  #clearFrame({ frame, token }: Attachment): void {
    if (frame.getAttribute(frameAttribute) === token) frame.removeAttribute(frameAttribute);
  }

  #detach(attachment: Attachment): void {
    attachment.detached = true;
    attachment.view.removeEventListener("dom-ready", attachment.onReady);
    this.#attachments.delete(attachment.view);
    this.#clearFrame(attachment);
    if (attachment.active) void updateGuest(attachment, false);
  }
}
