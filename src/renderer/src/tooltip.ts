/**
 * App-wide tooltips. Native `title` tooltips do not appear reliably in this window (transparent background
 * for the macOS glass sidebar) and are slow when they do, so every `title` in the app is shown by this one
 * styled layer instead. Components keep using plain `title="…"`; nothing else needs to change.
 *
 * On hover the `title` moves to `data-tip` (which also stops the native tooltip), and a single floating
 * element is placed below the target, or above it when there is no room.
 */

import { keys } from './platform';

const DELAY = 350;
/** After one tooltip closes, the next one opens without delay for this long (moving along a toolbar). */
const WARM_MS = 600;
const GAP = 8;
/** A tooltip is a hint, not a viewer: longer text (a whole script typed into a terminal) is cut with "…". */
const MAX_LINES = 6;
const MAX_CHARS = 300;

export function clampTip(text: string): string {
  const lines = text.split('\n');
  let out = lines.slice(0, MAX_LINES).join('\n');
  let cut = lines.length > MAX_LINES;
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS);
    cut = true;
  }
  return cut ? `${out.trimEnd()}…` : out;
}

let tip: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let lastHidden = 0;

function el(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'app-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  return tip;
}

function textOf(t: HTMLElement): string {
  const title = t.getAttribute('title');
  if (title) {
    t.setAttribute('data-tip', title);
    t.removeAttribute('title');
  }
  return t.getAttribute('data-tip') ?? '';
}

function place(t: HTMLElement) {
  const box = el();
  const r = t.getBoundingClientRect();
  box.style.left = '0px';
  box.style.top = '0px';
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let top = r.bottom + GAP;
  let below = true;
  if (top + h > window.innerHeight - 4) {
    top = r.top - GAP - h;
    below = false;
  }
  const left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), window.innerWidth - w - 6);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(4, top))}px`;
  box.dataset.side = below ? 'below' : 'above';
}

function show(t: HTMLElement) {
  const text = textOf(t);
  if (!text || !t.isConnected) return;
  const box = el();
  box.textContent = clampTip(keys(text));
  place(t);
  box.classList.add('visible');
}

function hide() {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  if (tip?.classList.contains('visible')) lastHidden = Date.now();
  tip?.classList.remove('visible');
  target = null;
}

export function installTooltips() {
  document.addEventListener(
    'mouseover',
    (e) => {
      let t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[title], [data-tip]') ?? null;
      // Text fields keep their hint out of the way while typing.
      if (t && t.matches('input, textarea, [contenteditable="true"]')) t = null;
      if (t === target) return;
      hide();
      if (!t) return;
      textOf(t);
      target = t;
      const warm = Date.now() - lastHidden < WARM_MS;
      showTimer = setTimeout(() => target === t && show(t), warm ? 0 : DELAY);
    },
    true,
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      if (!target) return;
      const to = e.relatedTarget as Node | null;
      if (!to || !target.contains(to)) hide();
    },
    true,
  );
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur'] as const) window.addEventListener(ev, hide, true);
  window.addEventListener('scroll', hide, true);
}
