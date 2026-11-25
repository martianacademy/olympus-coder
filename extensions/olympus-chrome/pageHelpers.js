/**
 * Olympus Coder Browser — Page-world serializable DOM helpers executed via `chrome.scripting.executeScript`.
 * Each exported function must be completely self-contained (no outer closures).
 */

/** Tags visible interactive elements with `data-oly-ref` and returns page snapshot data. */
export function readPageDom() {
  const sel =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  // Refs from an earlier read must not survive: a stale `data-oly-ref="5"` earlier in the page would win over
  // the new element 5 and the agent would click the wrong thing.
  for (const old of document.querySelectorAll('[data-oly-ref]')) old.removeAttribute('data-oly-ref');
  const nodes = [...document.querySelectorAll(sel)];
  const elements = [];
  let ref = 0;
  for (const el of nodes) {
    if (el.id === 'olympus-coder-overlay-host') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    ref++;
    el.setAttribute('data-oly-ref', String(ref));
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const nameAttr = (el.getAttribute('name') || el.id || '').toLowerCase();
    // Never send what the user typed into secret fields (passwords, card data, one-time codes) to the agent.
    const isPassword =
      inputType === 'password' ||
      ac.includes('password') ||
      ac.startsWith('cc-') ||
      ac === 'one-time-code' ||
      /\b(cvv|cvc|card.?number|credit.?card|otp)\b/.test(nameAttr);
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.innerText ||
      (!isPassword && 'value' in el ? el.value : '') ||
      el.getAttribute('title') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: inputType || undefined,
      label: label || '(unlabeled)',
      href: el.tagName === 'A' ? el.getAttribute('href')?.slice(0, 140) : undefined,
    });
    if (elements.length >= 90) break;
  }
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
  return { title: document.title, url: location.href, text, elements };
}

/**
 * Finds an element by `ref` or CSS `selector`, smoothly scrolls it into view if off-screen,
 * checks password/payment sensitivity, and returns viewport coordinates & bounding rect.
 */
export async function locateTarget(opts) {
  let el = null;
  if (typeof opts.ref === 'number') el = document.querySelector(`[data-oly-ref="${opts.ref}"]`);
  else if (opts.selector) el = document.querySelector(opts.selector);
  else if (opts.allowActive) el = document.activeElement;

  if (!el) return { found: false };

  const inputType = (el.getAttribute?.('type') || '').toLowerCase();
  const ac = (el.getAttribute?.('autocomplete') || '').toLowerCase();
  const nameAttr = (el.getAttribute?.('name') || '').toLowerCase();
  const isSensitive =
    inputType === 'password' ||
    ac.includes('password') ||
    ac.startsWith('cc-') ||
    /\b(cvv|cvc|card.?number|credit.?card)\b/.test(nameAttr);

  let rect = el.getBoundingClientRect();
  const margin = 72;
  const offscreen = rect.top < margin || rect.bottom > window.innerHeight - margin;
  if (offscreen) {
    const destTop = window.scrollY + rect.top - Math.round(window.innerHeight * 0.42);
    if (window.__olympusOverlay?.smoothScrollTo) {
      await window.__olympusOverlay.smoothScrollTo(destTop, 'Scrolling to element');
    } else {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await new Promise((r) => setTimeout(r, 320));
    }
    rect = el.getBoundingClientRect();
  }

  const label = (
    el.getAttribute?.('aria-label') ||
    el.getAttribute?.('placeholder') ||
    el.innerText ||
    el.getAttribute?.('title') ||
    el.tagName
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);

  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    label,
    isSensitive,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

/** Focuses an input/contenteditable target and optionally clears its existing content before typing. */
export function prepareInputFocus(opts) {
  let el = null;
  if (typeof opts.ref === 'number') el = document.querySelector(`[data-oly-ref="${opts.ref}"]`);
  else if (opts.selector) el = document.querySelector(opts.selector);
  else el = document.activeElement;
  if (!el) return false;
  el.focus?.();
  if (opts.clear !== false) {
    if ('select' in el && typeof el.select === 'function') {
      el.select();
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }
  return true;
}

/** DOM fallback for `<select>` or when `chrome.debugger` CDP is unavailable. */
export function domFallbackAct(opts) {
  let el = null;
  if (typeof opts.ref === 'number') el = document.querySelector(`[data-oly-ref="${opts.ref}"]`);
  else if (opts.selector) el = document.querySelector(opts.selector);
  else el = document.activeElement;
  if (!el) throw new Error('Target element not found. Call browser_read first.');

  if (opts.action === 'click') {
    el.click();
    return { ok: true, detail: `Clicked <${el.tagName.toLowerCase()}>`, url: location.href };
  }
  if (opts.action === 'select') {
    const val = String(opts.text ?? '');
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === val || o.text.trim().toLowerCase() === val.trim().toLowerCase());
      if (!opt) throw new Error(`Option "${val}" not found in <select>.`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `Selected "${opt.text.trim()}"`, url: location.href };
    }
    throw new Error(`Target <${el.tagName.toLowerCase()}> is not a <select> element.`);
  }
  if (opts.action === 'type') {
    el.focus();
    const val = String(opts.text ?? '');
    if ('value' in el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
    } else if (el.isContentEditable) {
      el.textContent = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, detail: `Typed into <${el.tagName.toLowerCase()}>`, url: location.href };
  }
  if (opts.action === 'press') {
    const key = String(opts.text || 'Enter');
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    return { ok: true, detail: `Pressed ${key}`, url: location.href };
  }
  return { ok: true, detail: `Completed ${opts.action}`, url: location.href };
}

/** Polls until a CSS selector or visible text appears on the page (for `wait` action). */
export async function waitInPage(opts) {
  const timeoutMs = Math.max(100, Math.min(10000, Number(opts.ms) || 1500));
  if (!opts.selector && !opts.text) {
    await new Promise((r) => setTimeout(r, timeoutMs));
    return { ok: true, detail: `Waited ${timeoutMs}ms`, url: location.href };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.selector && document.querySelector(opts.selector)) {
      return { ok: true, detail: `Matched selector "${opts.selector}"`, url: location.href };
    }
    if (opts.text && (document.body?.innerText || '').includes(opts.text)) {
      return { ok: true, detail: `Found text "${opts.text.slice(0, 40)}"`, url: location.href };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${opts.selector || opts.text}.`);
}

/**
 * Blurs secret fields (passwords, card data, one-time codes) for the instant of a screenshot, or removes the
 * blur again (`on: false`), so a screenshot never shows what the text read already leaves out.
 */
export function maskSensitiveFields(on) {
  const STYLE_ID = 'olympus-coder-mask-style';
  document.getElementById(STYLE_ID)?.remove();
  for (const el of document.querySelectorAll('[data-oly-mask]')) el.removeAttribute('data-oly-mask');
  if (!on) return 0;
  let n = 0;
  for (const el of document.querySelectorAll('input, textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const name = (el.getAttribute('name') || el.id || '').toLowerCase();
    if (
      type === 'password' ||
      ac.includes('password') ||
      ac.startsWith('cc-') ||
      ac === 'one-time-code' ||
      /\b(cvv|cvc|card.?number|credit.?card|otp)\b/.test(name)
    ) {
      el.setAttribute('data-oly-mask', '');
      n++;
    }
  }
  if (n) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '[data-oly-mask]{filter:blur(7px)!important;color:transparent!important;text-shadow:0 0 8px rgba(0,0,0,.6)!important}';
    (document.head || document.documentElement).appendChild(style);
  }
  return n;
}
