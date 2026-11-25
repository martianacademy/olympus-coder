/**
 * Olympus Coder Browser — In-Page Live Visual Overlay (Shadow DOM isolated).
 * Renders a subtle animated orange viewport glow, a smooth Bezier-gliding virtual cursor,
 * element focus highlight ring, expanding click ripple, smooth animated scrolling,
 * and a floating bottom status pill with an instant Stop button.
 */
(() => {
  const VERSION = 3;
  const HOST_ID = 'olympus-coder-overlay-host';
  const existing = window.__olympusOverlay;
  // Keep a live overlay of this version. One left by an older or reloaded extension is replaced: its
  // chrome.runtime is dead, so its Stop button could no longer reach the extension.
  if (existing?.version === VERSION && chrome.runtime?.id) return;
  try {
    existing?.destroy?.();
  } catch {}
  document.getElementById(HOST_ID)?.remove();

  const POS_KEY = '__olympus_cursor_pos';

  let host = null;
  let shadow = null;
  let borderEl = null;
  let cursorEl = null;
  let highlightEl = null;
  let pillEl = null;
  let pillTextEl = null;
  let rippleHostEl = null;

  let curX = Math.round(window.innerWidth * 0.5);
  let curY = Math.round(window.innerHeight * 0.45);
  try {
    const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      curX = Math.max(8, Math.min(window.innerWidth - 8, saved.x));
      curY = Math.max(8, Math.min(window.innerHeight - 8, saved.y));
    }
  } catch {}

  const CSS = `
    :host { all: initial; }
    .oly-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif;
      opacity: 0;
      transition: opacity 260ms ease;
      -webkit-font-smoothing: antialiased;
    }
    .oly-root.visible { opacity: 1; }

    /* Edge glow: soft light breathing in from the window edges, like the app's working state. */
    .oly-edge, .oly-edge-wide {
      position: fixed;
      inset: 0;
      pointer-events: none;
      animation: olyBreathe 3.4s ease-in-out infinite;
    }
    .oly-edge {
      box-shadow:
        inset 0 0 0 1.5px rgba(232, 135, 102, 0.85),
        inset 0 0 12px rgba(232, 135, 102, 0.55);
    }
    .oly-edge-wide {
      box-shadow:
        inset 0 0 40px rgba(232, 135, 102, 0.42),
        inset 0 0 120px rgba(232, 135, 102, 0.2);
      animation-name: olyBreatheWide;
    }
    @keyframes olyBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
    @keyframes olyBreatheWide { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }

    .oly-highlight {
      position: fixed;
      pointer-events: none;
      border: 1.5px solid rgba(217, 119, 87, 0.95);
      background: rgba(217, 119, 87, 0.08);
      border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(217, 119, 87, 0.16), 0 0 18px rgba(217, 119, 87, 0.35);
      opacity: 0;
      transition: opacity 150ms ease, left 160ms ease, top 160ms ease, width 160ms ease, height 160ms ease;
    }
    .oly-highlight.show { opacity: 1; }
    .oly-cursor {
      position: fixed;
      left: 0;
      top: 0;
      width: 26px;
      height: 26px;
      pointer-events: none;
      transform: translate3d(-100px, -100px, 0);
      filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4)) drop-shadow(0 0 10px rgba(217, 119, 87, 0.55));
      transition: opacity 160ms ease;
      will-change: transform;
    }
    .oly-cursor.clicking svg { transform: scale(0.82); }
    .oly-cursor svg { display: block; width: 24px; height: 24px; transform-origin: 2px 2px; transition: transform 90ms ease; }
    .oly-ripple {
      position: fixed;
      width: 14px;
      height: 14px;
      margin-left: -7px;
      margin-top: -7px;
      border-radius: 999px;
      border: 2px solid #d97757;
      background: rgba(217, 119, 87, 0.22);
      pointer-events: none;
      animation: olyRipple 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes olyRipple { 0% { transform: scale(0.4); opacity: 1; } 100% { transform: scale(3.4); opacity: 0; } }

    /* Status card */
    .oly-pill {
      position: fixed;
      left: 50%;
      bottom: 22px;
      transform: translate(-50%, 12px);
      opacity: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 8px 8px 10px;
      border-radius: 16px;
      background: rgba(17, 17, 20, 0.88);
      color: #fafafa;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow:
        0 18px 48px rgba(0, 0, 0, 0.32),
        0 2px 8px rgba(0, 0, 0, 0.18),
        0 0 0 1px rgba(217, 119, 87, 0.18),
        0 0 28px rgba(217, 119, 87, 0.18);
      backdrop-filter: blur(18px) saturate(170%);
      -webkit-backdrop-filter: blur(18px) saturate(170%);
      pointer-events: auto;
      max-width: min(460px, calc(100vw - 32px));
      transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms ease;
    }
    .oly-root.visible .oly-pill { transform: translate(-50%, 0); opacity: 1; }
    /* Same mark and motion as the app's BrandWorkingMark (styles.css .wb-*): volcano, drawn cloud, erupting ball. */
    .oly-mark { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 7px; background: rgba(255, 255, 255, 0.07); }
    .oly-mark svg { overflow: visible; display: block; }
    .wb-volcano { fill: #d97757; }
    .wb-cloud { fill: none; stroke: #f5f5f5; stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 100; animation: sp-draw 2.4s cubic-bezier(.6, 0, .3, 1) infinite; }
    .wb-ball { fill: #f5f5f5; transform-origin: 50px 40px; animation: sp-erupt 1.2s ease-in-out infinite; }
    .wb-glow { fill: #d97757; opacity: 0; transform-origin: 50px 40px; animation: sp-glow 1.2s ease-out infinite; }
    .wb-code { display: inline-flex; gap: 4px; flex: none; align-items: center; }
    .wb-code i { display: block; height: 5px; border-radius: 3px; transform-origin: left center; transform: scaleX(0); opacity: 0; animation: sp-tok 2.4s ease-out infinite; }
    .wb-code i.k { background: #d97757; }
    .wb-code i.s { background: color-mix(in srgb, #d97757 55%, #ffd8b8); }
    .wb-code i.t { background: #f5f5f5; animation-name: sp-tok-ink; }
    @keyframes sp-draw { 0% { stroke-dashoffset: 100; } 45%, 60% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -100; } }
    @keyframes sp-erupt { 0%, 100% { transform: translateY(0); } 45% { transform: translateY(-3.2px); } }
    @keyframes sp-glow { 0% { opacity: .45; transform: scale(.6); } 80%, 100% { opacity: 0; transform: scale(2.6); } }
    @keyframes sp-tok { 0% { transform: scaleX(0); opacity: 0; } 8% { transform: scaleX(1); opacity: 1; } 78% { transform: scaleX(1); opacity: 1; } 92%, 100% { transform: scaleX(1); opacity: 0; } }
    @keyframes sp-tok-ink { 0% { transform: scaleX(0); opacity: 0; } 8% { transform: scaleX(1); opacity: .5; } 78% { transform: scaleX(1); opacity: .5; } 92%, 100% { transform: scaleX(1); opacity: 0; } }
    .oly-titlerow { display: flex; align-items: center; gap: 8px; }
    .oly-text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .oly-title { font-size: 12px; font-weight: 650; letter-spacing: 0.01em; color: #fff; line-height: 1.25; }
    .oly-label {
      font-size: 12px;
      line-height: 1.3;
      color: rgba(255, 255, 255, 0.68);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    .oly-label.swap { animation: olyFadeIn 220ms ease; }
    @keyframes olyFadeIn { from { opacity: 0.45; transform: translateY(2px); } to { opacity: 1; transform: none; } } /* never blank in a screenshot */
    .oly-stop {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-left: 4px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 6px 8px 6px 10px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      flex: none;
      transition: background 140ms ease, border-color 140ms ease, transform 90ms ease;
    }
    .oly-stop:hover { background: rgba(239, 68, 68, 0.92); border-color: rgba(239, 68, 68, 1); }
    .oly-stop:active { transform: scale(0.96); }
    .oly-stop i { width: 8px; height: 8px; border-radius: 2px; background: currentColor; display: block; }
    .oly-stop kbd {
      font-family: inherit;
      font-size: 10.5px;
      font-weight: 500;
      line-height: 1;
      padding: 3px 5px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.7);
    }
    @media (prefers-reduced-motion: reduce) {
      .oly-edge, .oly-edge-wide, .wb-cloud, .wb-ball, .wb-glow, .wb-code i { animation: none; }
      .oly-edge-wide { opacity: 0.6; }
      .wb-code i { transform: none; opacity: 1; }
    }
  `;

  function ensureMounted() {
    if (host && document.documentElement.contains(host)) return;
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'oly-root';

    // Edge glow: a tight edge light and a wide soft one, both breathing.
    borderEl = document.createElement('div');
    for (const cls of ['oly-edge-wide', 'oly-edge']) {
      const layer = document.createElement('div');
      layer.className = cls;
      borderEl.appendChild(layer);
    }

    highlightEl = document.createElement('div');
    highlightEl.className = 'oly-highlight';

    rippleHostEl = document.createElement('div');

    cursorEl = document.createElement('div');
    cursorEl.className = 'oly-cursor';
    cursorEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2.5L20 11.2L12.6 13.4L9.2 20.5L4 2.5Z" fill="#d97757" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>`;
    cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;

    pillEl = document.createElement('div');
    pillEl.className = 'oly-pill';
    const mark = document.createElement('span');
    mark.className = 'oly-mark';
    mark.innerHTML = `<svg width="16" height="13" viewBox="4 12 92 74" aria-hidden="true">
      <path class="wb-volcano" d="M 7 83 C 18.4 78.55 32.65 48.29 35.5 38.5 L 41.8 38.5 L 41.8 39.7 A 8.2 8.2 0 0 0 58.2 39.7 L 58.2 38.5 L 64.5 38.5 C 67.35 48.29 81.6 78.55 93 83 Z"/>
      <circle class="wb-glow" cx="50" cy="39.7" r="5.8"/>
      <path class="wb-cloud" pathLength="100" d="M 25 27 C 25 21.5 25 21.5 33 21.5 L 42 21.5 C 48.5 21.5 50 16 50 16 C 50 16 51.5 21.5 58 21.5 L 67 21.5 C 75 21.5 75 21.5 75 27"/>
      <circle class="wb-ball" cx="50" cy="39.7" r="5.8"/>
    </svg>`;
    const textBox = document.createElement('span');
    textBox.className = 'oly-text';
    const title = document.createElement('span');
    title.className = 'oly-title';
    title.textContent = 'Olympus Coder';
    const titleRow = document.createElement('span');
    titleRow.className = 'oly-titlerow';
    const code = document.createElement('span');
    code.className = 'wb-code';
    code.innerHTML = '<i class="k" style="width:10px;animation-delay:0s"></i><i class="t" style="width:15px;animation-delay:.12s"></i><i class="s" style="width:8px;animation-delay:.24s"></i>';
    titleRow.append(title, code);
    pillTextEl = document.createElement('span');
    pillTextEl.className = 'oly-label';
    pillTextEl.textContent = 'Agent is working…';
    textBox.append(titleRow, pillTextEl);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'oly-stop';
    stopBtn.type = 'button';
    stopBtn.title = 'Stop the agent (Alt+Shift+S)';
    const stopIcon = document.createElement('i');
    const stopKbd = document.createElement('kbd');
    stopKbd.textContent = /Mac/i.test(navigator.platform) ? '\u2325\u21e7S' : 'Alt+Shift+S'; // ⌥⇧S
    stopBtn.append(stopIcon, document.createTextNode('Stop'), stopKbd);
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      hide();
      try {
        chrome.runtime.sendMessage({ type: 'pause-from-page' });
      } catch {}
    });
    pillEl.append(mark, textBox, stopBtn);

    root.append(borderEl, highlightEl, rippleHostEl, cursorEl, pillEl);
    shadow.appendChild(root);
    (document.documentElement || document.body).appendChild(host);
    requestAnimationFrame(() => root.classList.add('visible'));
  }

  /** Kept for the service worker's call; the card draws the app's own animated mark instead of the PNG logo. */
  function brand() {
    ensureMounted();
  }

  function setStatus(text) {
    ensureMounted();
    if (!pillTextEl || !text || pillTextEl.textContent === text) return;
    pillTextEl.textContent = text;
    pillTextEl.classList.remove('swap');
    void pillTextEl.offsetWidth; // restart the fade-in
    pillTextEl.classList.add('swap');
  }

  function setHighlight(rect) {
    ensureMounted();
    if (!rect || rect.width < 1 || rect.height < 1) {
      highlightEl.classList.remove('show');
      return;
    }
    const pad = 3;
    highlightEl.style.left = `${Math.max(0, rect.left - pad)}px`;
    highlightEl.style.top = `${Math.max(0, rect.top - pad)}px`;
    highlightEl.style.width = `${rect.width + pad * 2}px`;
    highlightEl.style.height = `${rect.height + pad * 2}px`;
    highlightEl.classList.add('show');
  }

  function saveCursor() {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(curX), y: Math.round(curY) }));
    } catch {}
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /** Smoothly glides the virtual cursor from its current position to (targetX, targetY) along a natural slight arc. */
  function moveTo(targetX, targetY, label, rect) {
    ensureMounted();
    if (label) setStatus(label);
    const x1 = Math.max(4, Math.min(window.innerWidth - 4, targetX));
    const y1 = Math.max(4, Math.min(window.innerHeight - 4, targetY));
    const x0 = curX;
    const y0 = curY;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const duration = Math.max(180, Math.min(540, Math.round(160 + dist * 0.42)));

    // Gentle perpendicular control point so motion looks organic rather than robotic straight lines
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    const bend = Math.min(48, dist * 0.14) * (x1 >= x0 ? -1 : 1);
    const nx = dist > 1 ? -(y1 - y0) / dist : 0;
    const ny = dist > 1 ? (x1 - x0) / dist : 0;
    const cx = midX + nx * bend;
    const cy = midY + ny * bend;

    return new Promise((resolve) => {
      if (dist < 2) {
        curX = x1;
        curY = y1;
        cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        if (rect) setHighlight(rect);
        saveCursor();
        resolve();
        return;
      }
      const start = performance.now();
      function frame(now) {
        const raw = Math.min(1, (now - start) / duration);
        const t = easeInOutCubic(raw);
        const u = 1 - t;
        curX = u * u * x0 + 2 * u * t * cx + t * t * x1;
        curY = u * u * y0 + 2 * u * t * cy + t * t * y1;
        cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        if (raw >= 0.72 && rect) setHighlight(rect);
        if (raw < 1) {
          requestAnimationFrame(frame);
        } else {
          curX = x1;
          curY = y1;
          saveCursor();
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function spawnRipple(x, y) {
    ensureMounted();
    const r = document.createElement('div');
    r.className = 'oly-ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    rippleHostEl.appendChild(r);
    setTimeout(() => r.remove(), 560);
  }

  async function clickAt(x, y, label, rect) {
    await moveTo(x, y, label || 'Clicking', rect);
    cursorEl.classList.add('clicking');
    spawnRipple(curX, curY);
    await new Promise((r) => setTimeout(r, 120));
    cursorEl.classList.remove('clicking');
  }

  /** Smoothly animates vertical scrolling over ~420ms so the user visibly watches the page glide. */
  function smoothScrollTo(targetTop, label) {
    ensureMounted();
    if (label) setStatus(label);
    highlightEl?.classList.remove('show');
    const startTop = window.scrollY;
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const destTop = Math.max(0, Math.min(maxTop, targetTop));
    const delta = destTop - startTop;
    if (Math.abs(delta) < 2) return Promise.resolve(destTop);

    const duration = Math.max(240, Math.min(560, Math.round(220 + Math.abs(delta) * 0.28)));
    return new Promise((resolve) => {
      const start = performance.now();
      function step(now) {
        const raw = Math.min(1, (now - start) / duration);
        const t = easeInOutCubic(raw);
        window.scrollTo(window.scrollX, Math.round(startTop + delta * t));
        if (raw < 1) requestAnimationFrame(step);
        else resolve(window.scrollY);
      }
      requestAnimationFrame(step);
    });
  }

  async function scrollDirection(direction) {
    const d = direction || 'down';
    const label = d === 'top' ? 'Scrolling to top' : d === 'bottom' ? 'Scrolling to bottom' : `Scrolling ${d}`;
    let dest = window.scrollY;
    if (d === 'top') dest = 0;
    else if (d === 'bottom') dest = document.documentElement.scrollHeight;
    else dest = window.scrollY + (d === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.72);
    // Gently nudge cursor toward vertical center while scrolling
    const hintY = d === 'up' ? window.innerHeight * 0.35 : window.innerHeight * 0.65;
    void moveTo(curX, hintY, label, null);
    await smoothScrollTo(dest, label);
    return { scrollY: Math.round(window.scrollY), maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) };
  }

  function hide() {
    if (!host) return;
    const root = shadow?.querySelector('.oly-root');
    if (root) root.classList.remove('visible');
    const toRemove = host;
    host = null;
    shadow = null;
    setTimeout(() => toRemove.remove(), 220);
  }

  window.__olympusOverlay = {
    version: VERSION,
    destroy: () => {
      host?.remove();
      host = null;
      shadow = null;
    },
    show: (label) => {
      ensureMounted();
      if (label) setStatus(label);
    },
    setStatus,
    setHighlight,
    moveTo,
    clickAt,
    smoothScrollTo,
    scrollDirection,
    hide,
    brand,
  };
})();
