/**
 * Olympus Coder Browser — In-Page Live Visual Overlay (Shadow DOM isolated).
 * Renders a subtle animated orange viewport glow, a smooth Bezier-gliding virtual cursor,
 * element focus highlight ring, expanding click ripple, smooth animated scrolling,
 * and a floating bottom status pill with an instant Stop button.
 */
(() => {
  if (window.__olympusOverlay) return;

  const HOST_ID = 'olympus-coder-overlay-host';
  const POS_KEY = '__olympus_cursor_pos';

  let host = null;
  let shadow = null;
  let borderEl = null;
  let cursorEl = null;
  let highlightEl = null;
  let pillEl = null;
  let pillTextEl = null;
  let rippleHostEl = null;
  let pillDotEl = null;
  let pillLogoEl = null;
  let logoUrl = null;

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
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .oly-root.visible { opacity: 1; }
    .oly-border {
      position: fixed;
      inset: 0;
      pointer-events: none;
      box-shadow: inset 0 0 0 3px rgba(249, 115, 22, 0.85), inset 0 0 26px rgba(249, 115, 22, 0.28);
      animation: olyGlow 2.4s ease-in-out infinite;
    }
    @keyframes olyGlow {
      0%, 100% { box-shadow: inset 0 0 0 3px rgba(249, 115, 22, 0.85), inset 0 0 24px rgba(249, 115, 22, 0.24); }
      50% { box-shadow: inset 0 0 0 3px rgba(251, 146, 60, 0.98), inset 0 0 36px rgba(249, 115, 22, 0.42); }
    }
    .oly-highlight {
      position: fixed;
      pointer-events: none;
      border: 2px solid rgba(249, 115, 22, 0.95);
      background: rgba(249, 115, 22, 0.12);
      border-radius: 6px;
      box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.2);
      opacity: 0;
      transition: opacity 150ms ease, left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease;
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
      filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45)) drop-shadow(0 0 8px rgba(249, 115, 22, 0.55));
      transition: opacity 160ms ease;
      will-change: transform;
    }
    .oly-cursor.clicking svg {
      transform: scale(0.82);
    }
    .oly-cursor svg {
      display: block;
      width: 24px;
      height: 24px;
      transform-origin: 2px 2px;
      transition: transform 90ms ease;
    }
    .oly-ripple {
      position: fixed;
      width: 14px;
      height: 14px;
      margin-left: -7px;
      margin-top: -7px;
      border-radius: 999px;
      border: 2.5px solid #f97316;
      background: rgba(249, 115, 22, 0.25);
      pointer-events: none;
      animation: olyRipple 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes olyRipple {
      0% { transform: scale(0.4); opacity: 1; }
      100% { transform: scale(3.4); opacity: 0; }
    }
    .oly-pill {
      position: fixed;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px 7px 14px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      border: 1px solid rgba(249, 115, 22, 0.45);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      pointer-events: auto;
      font-size: 12px;
      line-height: 1.2;
      max-width: min(520px, calc(100vw - 32px));
    }
    .oly-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #f97316;
      box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7);
      animation: olyPulse 1.5s ease-out infinite;
      flex: none;
    }
    @keyframes olyPulse {
      0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.75); }
      70% { box-shadow: 0 0 0 8px rgba(249, 115, 22, 0); }
      100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0); }
    }
    .oly-logo {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      display: none;
      flex: none;
      animation: olyPulse 1.5s ease-out infinite;
    }
    .oly-logo.show { display: block; }
    .oly-dot.hidden { display: none; }
    .oly-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
      letter-spacing: 0.01em;
    }
    .oly-stop {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 4px 10px;
      background: rgba(239, 68, 68, 0.9);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      flex: none;
      transition: background 120ms ease, transform 90ms ease;
    }
    .oly-stop:hover { background: #dc2626; }
    .oly-stop:active { transform: scale(0.95); }
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

    borderEl = document.createElement('div');
    borderEl.className = 'oly-border';

    highlightEl = document.createElement('div');
    highlightEl.className = 'oly-highlight';

    rippleHostEl = document.createElement('div');

    cursorEl = document.createElement('div');
    cursorEl.className = 'oly-cursor';
    cursorEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 2.5L20 11.2L12.6 13.4L9.2 20.5L4 2.5Z" fill="#f97316" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>`;
    cursorEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;

    pillEl = document.createElement('div');
    pillEl.className = 'oly-pill';
    const dot = document.createElement('span');
    dot.className = 'oly-dot';
    pillDotEl = dot;
    pillLogoEl = document.createElement('img');
    pillLogoEl.className = 'oly-logo';
    pillLogoEl.alt = '';
    if (logoUrl) showPillLogo();
    pillTextEl = document.createElement('span');
    pillTextEl.className = 'oly-label';
    pillTextEl.textContent = 'Olympus Coder · Active';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'oly-stop';
    stopBtn.type = 'button';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      hide();
      try {
        chrome.runtime.sendMessage({ type: 'pause-from-page' });
      } catch {}
    });
    pillEl.append(dot, pillLogoEl, pillTextEl, stopBtn);

    root.append(borderEl, highlightEl, rippleHostEl, cursorEl, pillEl);
    shadow.appendChild(root);
    (document.documentElement || document.body).appendChild(host);
    requestAnimationFrame(() => root.classList.add('visible'));
  }

  function showPillLogo() {
    if (!pillLogoEl || !logoUrl) return;
    pillLogoEl.src = logoUrl;
    pillLogoEl.classList.add('show');
    pillDotEl?.classList.add('hidden');
  }

  function brand(logo) {
    ensureMounted();
    if (logo) {
      logoUrl = logo;
      showPillLogo();
    }
  }

  function setStatus(text) {
    ensureMounted();
    if (pillTextEl && text) pillTextEl.textContent = `Olympus Coder · ${text}`;
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
