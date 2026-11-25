/**
 * Olympus Coder Browser — Chrome DevTools Protocol (`chrome.debugger`) controller.
 * Provides authentic OS-grade mouse/keyboard input (works on React, Shadow DOM, Canvas, SPAs)
 * plus live console error and failed network request capture per tab, with safe graceful fallback.
 */

const MAX_LOG_ITEMS = 60;

/** @type {Map<number, { attached: boolean, console: string[], network: string[], requests: Map<string, { method: string, url: string }> }>} */
const tabs = new Map();

function tabState(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = { attached: false, console: [], network: [], requests: new Map() };
    tabs.set(tabId, st);
  }
  return st;
}

function pushBounded(arr, item) {
  arr.push(item);
  if (arr.length > MAX_LOG_ITEMS) arr.splice(0, arr.length - MAX_LOG_ITEMS);
}

const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function ensureCdpAttached(tabId) {
  if (!chrome.debugger) return false;
  const st = tabState(tabId);
  if (st.attached) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    st.attached = true;
    await Promise.allSettled([
      sendCommand(tabId, 'Runtime.enable'),
      sendCommand(tabId, 'Log.enable'),
      sendCommand(tabId, 'Network.enable', { maxPostDataSize: 0 }),
      sendCommand(tabId, 'Page.enable'),
    ]);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Already attached')) {
      st.attached = true;
      return true;
    }
    return false;
  }
}

export async function detachCdpTab(tabId) {
  const st = tabs.get(tabId);
  if (!st?.attached) return;
  st.attached = false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

export async function detachAllCdp() {
  const ids = [...tabs.keys()];
  await Promise.allSettled(ids.map((id) => detachCdpTab(id)));
}

export function getTabDiagnostics(tabId, opts = {}) {
  const st = tabs.get(tabId);
  if (!st) return { console: [], network: [] };
  return {
    console: opts.console ? st.console.slice(-30) : [],
    network: opts.network ? st.network.slice(-30) : [],
  };
}

/**
 * Screenshot through CDP: renders a fresh frame even when the tab is in the background or its window is covered
 * (captureVisibleTab then returns the last frame Chrome happened to paint, which can be stale). Null on failure.
 */
export async function cdpScreenshot(tabId) {
  if (!(await ensureCdpAttached(tabId))) return null;
  try {
    const res = await sendCommand(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: true });
    return res?.data ? `data:image/jpeg;base64,${res.data}` : null;
  } catch {
    return null;
  }
}

export async function cdpMove(tabId, x, y) {
  if (!(await ensureCdpAttached(tabId))) return false;
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    button: 'none',
    buttons: 0,
  });
  return true;
}

export async function cdpClick(tabId, x, y) {
  if (!(await ensureCdpAttached(tabId))) return false;
  const rx = Math.round(x);
  const ry = Math.round(y);
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rx, y: ry });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rx,
    y: ry,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 45));
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rx,
    y: ry,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return true;
}

/** Inserts text in visible human-like fast bursts (capped at ~420ms total) via CDP Input.insertText. */
export async function cdpType(tabId, text) {
  if (!(await ensureCdpAttached(tabId))) return false;
  const str = String(text ?? '');
  if (!str) return true;
  const chunkSize = str.length <= 24 ? 1 : Math.max(2, Math.ceil(str.length / 22));
  for (let i = 0; i < str.length; i += chunkSize) {
    const chunk = str.slice(i, i + chunkSize);
    await sendCommand(tabId, 'Input.insertText', { text: chunk });
    if (i + chunkSize < str.length) await new Promise((r) => setTimeout(r, 18));
  }
  return true;
}

const MODIFIERS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** Splits "Control+Shift+A" / "Meta+Enter" into a CDP modifier bitmask and the main key. */
export function parseKeyCombo(combo) {
  const parts = String(combo || 'Enter').split('+').map((p) => p.trim());
  let modifiers = 0;
  while (parts.length > 1 && MODIFIERS[parts[0].toLowerCase()] !== undefined) modifiers |= MODIFIERS[parts.shift().toLowerCase()];
  return { modifiers, key: parts.join('+') || '+' };
}

export async function cdpPress(tabId, keyName) {
  if (!(await ensureCdpAttached(tabId))) return false;
  const { modifiers, key } = parseKeyCombo(keyName);
  const spec = SPECIAL_KEYS[key] || {
    key,
    code: key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key) : key,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    text: key.length === 1 ? key : undefined,
  };
  // With Ctrl/Alt/Meta held the key is a shortcut, not typed text.
  const text = spec.text && !(modifiers & 7) ? spec.text : undefined;
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await new Promise((r) => setTimeout(r, 25));
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  });
  return true;
}

if (chrome.debugger) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;
    const st = tabState(tabId);

    if (method === 'Runtime.consoleAPICalled') {
      const level = params?.type || 'log';
      const args = (params?.args || [])
        .map((a) => a.value ?? a.description ?? a.type ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 260);
      if (args) pushBounded(st.console, `[${level}] ${args}`);
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails;
      const text = details?.exception?.description || details?.text || 'Uncaught exception';
      pushBounded(st.console, `[exception] ${String(text).replace(/\s+/g, ' ').slice(0, 260)}`);
    } else if (method === 'Log.entryAdded') {
      const entry = params?.entry;
      if (entry?.text) pushBounded(st.console, `[${entry.level || 'log'}] ${String(entry.text).slice(0, 260)}`);
    } else if (method === 'Page.javascriptDialogOpening') {
      // A JS dialog freezes the page (every later step would time out). An alert is just acknowledged; confirm,
      // prompt and "leave page?" are answered No, so the agent never confirms something on the user's behalf.
      const accept = params?.type === 'alert';
      void sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept }).catch(() => {});
      pushBounded(st.console, `[dialog] ${params?.type || 'dialog'}: "${String(params?.message || '').slice(0, 200)}" → ${accept ? 'OK' : 'dismissed (Cancel)'}`);
    } else if (method === 'Network.requestWillBeSent') {
      if (params?.requestId && params?.request?.url) {
        st.requests.set(params.requestId, {
          method: params.request.method || 'GET',
          url: String(params.request.url).slice(0, 180),
        });
        if (st.requests.size > 200) {
          const oldest = st.requests.keys().next().value;
          st.requests.delete(oldest);
        }
      }
    } else if (method === 'Network.responseReceived') {
      const res = params?.response;
      if (res?.status >= 400) {
        const req = st.requests.get(params.requestId);
        pushBounded(st.network, `${res.status} ${req?.method || 'GET'} ${String(res.url || req?.url || '').slice(0, 180)}`);
      }
    } else if (method === 'Network.loadingFailed') {
      const req = st.requests.get(params.requestId);
      if (!params?.canceled) {
        pushBounded(st.network, `FAILED (${params?.errorText || 'network'}) ${req?.method || 'GET'} ${req?.url || ''}`);
      }
    }
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === 'number') {
      const st = tabs.get(source.tabId);
      if (st) st.attached = false;
    }
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});
