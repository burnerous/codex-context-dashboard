export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const homeComposerSelector = '[data-composer-placement="home"]';
export const pendingComposerMarker = "[data-pending-composer-end]";
const conversationComposerSelector = 'form[data-thread-find-composer="true"]';

export function visibleComposerElement(element: HTMLElement) {
  return element.getClientRects().length > 0 && !element.closest('[inert], [hidden], [aria-hidden="true"]');
}

export function currentComposer(document: Document, hostSelector: string) {
  const nativeSelector = [hostSelector, homeComposerSelector].filter(Boolean).join(", ");
  const selector = `${nativeSelector}, ${conversationComposerSelector}`;
  const roots = new Set<HTMLElement>();
  for (const root of document.querySelectorAll<HTMLElement>(selector)) {
    // Prefer the native wrapper when it contains the conversation form and its thread information.
    roots.add(root.parentElement?.closest<HTMLElement>(nativeSelector) ?? root);
  }
  for (const marker of document.querySelectorAll(pendingComposerMarker)) {
    const parent = marker.parentElement;
    if (parent) roots.add(parent.closest<HTMLElement>(selector) ?? parent);
  }
  const candidates = [...roots].filter(visibleComposerElement);
  return candidates.findLast((root) => root.contains(document.activeElement)) ?? candidates[0] ?? null;
}

export const buttonGap = 6;

const buttonSizes = [
  { speedWidth: 94, usageWidth: 134 },
  { speedWidth: 90, usageWidth: 109 },
  { speedWidth: 88, usageWidth: 30 },
  { speedWidth: 30, usageWidth: 30 },
  { speedWidth: 32, usageWidth: 0 },
];

export function composerSlot(surface: Box, controls: Box[], rowY: number) {
  const row = controls
    .filter((box) => box.right > surface.left && box.left < surface.right
      && Math.abs((box.top + box.bottom) / 2 - rowY) <= 14)
    .sort((a, b) => a.left - b.left);
  if (row.length < 2) return null;
  let right = row[0].right;
  let best: { end: number; span: number } | null = null;
  for (const box of row.slice(1)) {
    const span = box.left - right;
    if (span > (best?.span ?? 0)) best = { end: box.left, span };
    right = Math.max(right, box.right);
  }
  if (!best) return null;
  for (const size of buttonSizes) {
    const width = size.speedWidth + (size.usageWidth ? buttonGap + size.usageWidth : 0);
    if (width + 16 <= best.span) return { left: best.end - 8 - width, top: rowY - 15, ...size };
  }
  return null;
}
