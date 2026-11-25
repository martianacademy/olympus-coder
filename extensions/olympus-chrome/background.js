/**
 * Olympus Coder Browser — MV3 Service Worker
 * Zero-token loopback WebSocket bridge (`ws://127.0.0.1:47819/`) with live in-page visual cursor,
 * glowing active-tab border, smooth scrolling, instant Stop button, and `chrome.debugger` CDP input + logs.
 */
import { cdpClick, cdpMove, cdpPress, cdpScreenshot, cdpType, detachAllCdp, detachCdpTab, ensureCdpAttached, getTabDiagnostics } from './cdp.js';
import { domFallbackAct, locateTarget, maskSensitiveFields, prepareInputFocus, readPageDom, waitInPage } from './pageHelpers.js';

const DEFAULT_PORT = 47819;
const KEEPALIVE_ALARM = 'olympus-bridge-keepalive';
const IDLE_CLEANUP_MS = 25_000;

let ws = null;
let reconnectTimer = null;
let idleTimer = null; // non-null while an agent is actively using the browser
let connected = false;
let cfg = { port: DEFAULT_PORT };
const STOP_HOLD_MS = 15_000;
// MV3 ends an idle service worker after ~30s; a WebSocket message resets that timer (Chrome 116+), so the
// connection — and the toolbar dot — stays up instead of dropping and reconnecting every half minute.
const HEARTBEAT_MS = 20_000;
let heartbeatTimer = null;
/** Tabs opened from a tab the agent is working in (link with target=_blank, window.open). */
const recentlyOpened = [];
let stoppedUntil = 0;
const activeOverlayTabs = new Set();

async function loadConfig() {
  const stored = await chrome.storage.local.get(['port']);
  cfg = { port: Number(stored.port) || DEFAULT_PORT };
  return cfg;
}

// ── Toolbar status dot: green = agent working, yellow = connected & idle, red = not connected ──
const STATUS = {
  working: { color: '#22c55e', title: 'Agent is using this browser' },
  idle: { color: '#eab308', title: 'Connected to Olympus Coder · idle' },
  offline: { color: '#ef4444', title: 'Not connected · open Olympus Coder' },
};
let shownStatus = '';
let iconBitmapPromise = null;

function iconBitmap() {
  iconBitmapPromise ??= fetch(chrome.runtime.getURL('icon.png'))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
  return iconBitmapPromise;
}

function currentStatus() {
  if (!connected) return 'offline';
  return idleTimer ? 'working' : 'idle';
}

async function updateBadge() {
  const status = currentStatus();
  if (status === shownStatus) return;
  shownStatus = status;
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: `Olympus Coder Browser · ${STATUS[status].title}` });
  try {
    const bmp = await iconBitmap();
    const imageData = {};
    for (const size of [16, 32]) {
      const ctx = new OffscreenCanvas(size, size).getContext('2d');
      ctx.drawImage(bmp, 0, 0, size, size);
      const r = size * 0.21;
      const cx = size - r - size * 0.02;
      const cy = size - r - size * 0.02;
      // transparent gap around the dot so it reads on any toolbar colour
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, r + size * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = STATUS[status].color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    if (shownStatus === status) await chrome.action.setIcon({ imageData });
  } catch {
    shownStatus = ''; // retry on the next state change
  }
}

async function hideAllOverlays() {
  const ids = [...activeOverlayTabs];
  activeOverlayTabs.clear();
  await Promise.allSettled(
    ids.map((tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__olympusOverlay?.hide(),
      }),
    ),
  );
}

function touchActivity() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void updateBadge();
    void hideAllOverlays();
    void detachAllCdp();
  }, IDLE_CLEANUP_MS);
  void updateBadge();
}

function endActivity() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  void updateBadge();
}

async function ensureOverlay(tabId, statusText) {
  activeOverlayTabs.add(tabId);
  touchActivity();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    if (statusText) {
      await chrome.scripting.executeScript({
        target: { tabId },
        args: [statusText],
        func: (label) => window.__olympusOverlay?.show(label),
      });
    }
  } catch {
    /* ignore restricted pages */
  }
}

async function overlayCall(tabId, method, ...args) {
  activeOverlayTabs.add(tabId);
  touchActivity();
  const res = await chrome.scripting
    .executeScript({
      target: { tabId },
      args: [method, args],
      func: async (m, a) => {
        const api = window.__olympusOverlay;
        if (!api || typeof api[m] !== 'function') return null;
        return await api[m](...a);
      },
    })
    .catch(() => null);
  return res?.[0]?.result ?? null;
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

async function connect() {
  await loadConfig();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = `ws://127.0.0.1:${cfg.port}/`;
  try {
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      connected = true;
      void updateBadge();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
      sock.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version, paused: false }));
    });
    sock.addEventListener('message', (ev) => void onBridgeMessage(sock, String(ev.data)));
    sock.addEventListener('close', () => {
      if (ws === sock) {
        ws = null;
        connected = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        void updateBadge();
        void hideAllOverlays();
        void detachAllCdp();
        scheduleReconnect(3000);
      }
    });
    sock.addEventListener('error', () => {
      if (ws === sock) {
        connected = false;
        void updateBadge();
      }
    });
  } catch {
    connected = false;
    void updateBadge();
    scheduleReconnect(4000);
  }
}

const GROUP_TITLE = 'Olympus Coder';
const LEGACY_GROUP_TITLES = ['Olympus'];

/** Olympus tab groups; groups made by older builds ("Olympus") are renamed in place. */
async function findOlympusGroups(filter = {}) {
  const groups = await chrome.tabGroups.query({ ...filter, title: GROUP_TITLE }).catch(() => []);
  for (const title of LEGACY_GROUP_TITLES) {
    const legacy = await chrome.tabGroups.query({ ...filter, title }).catch(() => []);
    for (const g of legacy) {
      await chrome.tabGroups.update(g.id, { title: GROUP_TITLE }).catch(() => {});
      groups.push(g);
    }
  }
  return groups;
}

async function ensureOlympusGroup(tabId, windowId) {
  try {
    const groups = await findOlympusGroups({ windowId });
    if (groups.length > 0) {
      await chrome.tabs.group({ groupId: groups[0].id, tabIds: [tabId] });
      return groups[0].id;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'orange' });
    return groupId;
  } catch {
    return -1;
  }
}

async function waitForTabLoad(tabId, timeoutMs = 10000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (!existing || existing.status === 'complete') return existing;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      void chrome.tabs.get(tabId).then(resolve).catch(() => resolve(null));
    }, timeoutMs);
    const onUpd = (id, info, tab) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function resolveTargetTab(tabId) {
  if (typeof tabId === 'number') {
    const t = await chrome.tabs.get(tabId);
    if (!t) throw new Error(`Tab ${tabId} not found.`);
    return t;
  }
  const olympusGroups = await findOlympusGroups();
  if (olympusGroups.length) {
    const groupTabs = await chrome.tabs.query({ groupId: olympusGroups[0].id });
    if (groupTabs.length) return groupTabs.find((t) => t.active) || groupTabs[groupTabs.length - 1];
  }
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active.length) throw new Error('No active Chrome tab found.');
  return active[0];
}

function assertWebTab(tab) {
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(`Cannot inspect internal or non-web tab (${tab?.url || 'unknown'}).`);
  }
}

async function handleTabs() {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}).catch(() => []),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.title || g.color || 'group']));
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title || '',
      url: t.url || '',
      active: Boolean(t.active),
      group: t.groupId && t.groupId !== -1 ? groupName.get(t.groupId) : undefined,
    })),
  };
}

async function handleOpen({ url, tabId }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only http:// and https:// URLs are allowed.');
  let tab;
  if (typeof tabId === 'number') {
    tab = await chrome.tabs.update(tabId, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ url, active: true });
    if (tab?.id != null && tab?.windowId != null) await ensureOlympusGroup(tab.id, tab.windowId);
  }
  if (tab?.id != null) void ensureCdpAttached(tab.id);
  const loaded = tab?.id != null ? await waitForTabLoad(tab.id) : tab;
  if (loaded?.id != null) await ensureOverlay(loaded.id, `Opened ${new URL(url).hostname}`);
  return { id: loaded?.id ?? tab?.id, title: loaded?.title || '', url: loaded?.url || url };
}

async function handleRead({ tabId, screenshot, console: wantConsole, network: wantNetwork }) {
  const tab = await resolveTargetTab(tabId);
  assertWebTab(tab);
  await ensureOverlay(tab.id, 'Reading page');
  if (wantConsole || wantNetwork) await ensureCdpAttached(tab.id);

  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageDom });
  const diag = getTabDiagnostics(tab.id, { console: Boolean(wantConsole), network: Boolean(wantNetwork) });

  let screenshotDataUrl;
  if (screenshot) {
    const mask = (on) => chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [on], func: maskSensitiveFields }).catch(() => null);
    const masked = (await mask(true))?.[0]?.result > 0;
    try {
      // CDP renders a fresh frame (with the blur) without switching tabs; captureVisibleTab is only the fallback.
      screenshotDataUrl = await cdpScreenshot(tab.id);
      if (!screenshotDataUrl && tab.windowId != null) {
        if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 250)); // let the tab paint, or the capture shows an older frame
        screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
      }
    } finally {
      if (masked) await mask(false);
    }
  }
  return {
    id: tab.id,
    ...result,
    ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
    ...(diag.console.length ? { console: diag.console } : {}),
    ...(diag.network.length ? { network: diag.network } : {}),
  };
}

async function handleAct(params) {
  const { action, tabId, ref, selector, text, direction, x, y } = params;
  const tab = await resolveTargetTab(tabId);
  assertWebTab(tab);
  await chrome.tabs.update(tab.id, { active: true });

  if (action === 'back' || action === 'forward' || action === 'reload') {
    await ensureOverlay(tab.id, action === 'reload' ? 'Reloading page' : `Going ${action}`);
    if (action === 'back') await chrome.tabs.goBack(tab.id);
    else if (action === 'forward') await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.reload(tab.id);
    const loaded = await waitForTabLoad(tab.id);
    await ensureOverlay(tab.id, 'Ready');
    return { ok: true, detail: `Navigated (${action})`, url: loaded?.url || tab.url };
  }

  await ensureOverlay(tab.id, 'Working…');

  if (action === 'scroll') {
    const info = await overlayCall(tab.id, 'scrollDirection', direction || 'down');
    return {
      ok: true,
      detail: `Scrolled ${direction || 'down'}${info ? ` (y=${info.scrollY}/${info.maxScrollY})` : ''}`,
      url: tab.url,
    };
  }

  if (action === 'wait') {
    await overlayCall(tab.id, 'setStatus', text ? `Waiting for "${String(text).slice(0, 30)}"` : 'Waiting…');
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ selector, text, ms: typeof x === 'number' ? x : undefined }],
      func: waitInPage,
    });
    return result;
  }

  // Coordinate-only click/hover (great for Canvas / maps / custom widgets)
  if ((action === 'click' || action === 'hover') && typeof x === 'number' && typeof y === 'number' && ref == null && !selector) {
    if (action === 'hover') {
      await overlayCall(tab.id, 'moveTo', x, y, `Hovering (${x}, ${y})`, null);
      await cdpMove(tab.id, x, y);
      return { ok: true, detail: `Hovered at (${x}, ${y})`, url: tab.url };
    }
    await overlayCall(tab.id, 'clickAt', x, y, `Clicking (${x}, ${y})`, null);
    const since = Date.now();
    await cdpClick(tab.id, x, y);
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, detail: `Clicked at (${x}, ${y})${newTabsNote(tab.id, since)}`, url: tab.url };
  }

  const [{ result: target }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ ref, selector, allowActive: action === 'press' || action === 'type' }],
    func: locateTarget,
  });
  if (!target?.found) throw new Error('Target element not found. Call browser_read first to get fresh refs.');

  if (action === 'type' && target.isSensitive) {
    throw new Error('Blocked: Olympus refuses to type into password or payment-card fields.');
  }

  if (action === 'hover') {
    await overlayCall(tab.id, 'moveTo', target.x, target.y, `Hovering "${target.label}"`, target.rect);
    await cdpMove(tab.id, target.x, target.y);
    return { ok: true, detail: `Hovered <${target.tag}> "${target.label}"`, url: tab.url };
  }

  if (action === 'click') {
    await overlayCall(tab.id, 'clickAt', target.x, target.y, `Clicking "${target.label}"`, target.rect);
    const since = Date.now();
    const usedCdp = await cdpClick(tab.id, target.x, target.y);
    if (!usedCdp) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [{ action: 'click', ref, selector }], func: domFallbackAct });
    }
    await new Promise((r) => setTimeout(r, 300));
    const latest = await chrome.tabs.get(tab.id).catch(() => tab);
    return { ok: true, detail: `Clicked <${target.tag}> "${target.label}"${newTabsNote(tab.id, since)}`, url: latest.url };
  }

  if (action === 'select') {
    await overlayCall(tab.id, 'clickAt', target.x, target.y, `Selecting "${String(text ?? '').slice(0, 28)}"`, target.rect);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ action: 'select', ref, selector, text }],
      func: domFallbackAct,
    });
    return result;
  }

  if (action === 'type') {
    await overlayCall(tab.id, 'clickAt', target.x, target.y, `Typing into "${target.label}"`, target.rect);
    await cdpClick(tab.id, target.x, target.y);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [{ ref, selector, clear: true }], func: prepareInputFocus });
    const usedCdp = await cdpType(tab.id, String(text ?? ''));
    if (!usedCdp) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [{ action: 'type', ref, selector, text }], func: domFallbackAct });
    }
    return { ok: true, detail: `Typed into <${target.tag}> "${target.label}"`, url: tab.url };
  }

  if (action === 'press') {
    const key = String(text || 'Enter');
    await overlayCall(tab.id, 'setStatus', `Pressing ${key}`);
    const usedCdp = await cdpPress(tab.id, key);
    if (!usedCdp) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [{ action: 'press', ref, selector, text: key }], func: domFallbackAct });
    }
    await new Promise((r) => setTimeout(r, 140));
    const latest = await chrome.tabs.get(tab.id).catch(() => tab);
    return { ok: true, detail: `Pressed ${key}`, url: latest.url };
  }

  throw new Error(`Unsupported action "${action}".`);
}

/** " · opened new tab [id]" when the action opened tabs, so the agent can follow them. */
function newTabsNote(openerId, since) {
  const ids = recentlyOpened.filter((t) => t.opener === openerId && t.at >= since).map((t) => t.id);
  return ids.length ? ` · opened new tab ${ids.map((id) => `[${id}]`).join(', ')}` : '';
}

async function handleClose({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pinned) throw new Error('Refusing to close a pinned tab.');
  await detachCdpTab(tabId);
  activeOverlayTabs.delete(tabId);
  await chrome.tabs.remove(tabId);
  return { ok: true };
}

/** Page Stop button: end the current run now and refuse agent calls briefly so the agent asks the user first. */
async function stopFromPage() {
  stoppedUntil = Date.now() + STOP_HOLD_MS;
  endActivity();
  await hideAllOverlays();
  await detachAllCdp();
}

async function onBridgeMessage(sock, raw) {
  let req;
  try { req = JSON.parse(raw); } catch { return; }
  if (typeof req?.id !== 'number' || !req.method) return;
  const reply = (payload) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ id: req.id, ...payload }));
  };
  if (Date.now() < stoppedUntil) {
    return reply({ error: 'The user pressed Stop in Chrome. Stop using the browser and ask the user before continuing.' });
  }
  touchActivity();
  try {
    let result;
    if (req.method === 'tabs') result = await handleTabs();
    else if (req.method === 'open') result = await handleOpen(req.params || {});
    else if (req.method === 'read') result = await handleRead(req.params || {});
    else if (req.method === 'act') result = await handleAct(req.params || {});
    else if (req.method === 'close') result = await handleClose(req.params || {});
    else throw new Error(`Unknown method "${req.method}".`);
    reply({ result });
  } catch (e) {
    reply({ error: String(e?.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'pause-from-page') return false;
  void stopFromPage().then(() => sendResponse({ ok: true }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeOverlayTabs.delete(tabId);
});

// A tab opened while the agent works in its opener (target=_blank link, window.open) joins the Olympus group,
// so every tab the agent caused stays together and is easy to find and close.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null || tab.openerTabId == null || !idleTimer || !activeOverlayTabs.has(tab.openerTabId)) return;
  recentlyOpened.push({ id: tab.id, opener: tab.openerTabId, at: Date.now() });
  if (recentlyOpened.length > 20) recentlyOpened.shift();
  if (tab.windowId != null) void ensureOlympusGroup(tab.id, tab.windowId);
});

// Keyboard Stop (default Alt+Shift+S), for when the page pill is out of reach.
chrome.commands?.onCommand.addListener((command) => {
  if (command === 'stop-agent') void stopFromPage();
});

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE_ALARM) void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.remove(['paused', 'enabled']); // settings of the removed popup
  void connect();
});
void updateBadge();
void connect();
