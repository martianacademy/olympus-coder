# Olympus Coder Browser (Chrome extension)

Lets the coding agents you run in **Olympus Coder** (Claude Code, Codex, Antigravity, OpenCode, Ollama and others) see and use your real Chrome, with your own logins, while you watch.

## What agents can do
Through five tools (`browser_tabs`, `browser_open`, `browser_read`, `browser_act`, `browser_close`) an agent can:
- open pages
- read a page's text and its links and buttons
- take a screenshot
- see console errors and failed network requests
- click, hover, type, press keys and shortcuts (`Enter`, `Control+A`, `Meta+K`)
- choose options, scroll, wait, and go back, forward or reload

## What you see
- Agent tabs are grouped as **Olympus Coder**. A tab that an agent's click opens joins the group too, and the agent is told its id.
- While an agent works, the page shows an orange border, a moving cursor and a status pill.
- **Stop** on the pill, or **Alt+Shift+S**, halts the agent at once. For 15 seconds after a Stop, every request is refused, so the agent has to ask you first.
- The toolbar icon has a status dot: green while an agent is using Chrome, yellow when connected and idle, red when Olympus Coder isn't running. Clicking the icon does nothing.

## Safety
- The extension connects only to the app on this computer (`ws://127.0.0.1:47819`), and the app accepts only this extension's ID. It needs no token and makes no other network requests.
- The agent never gets values typed into password, payment-card or one-time-code fields. It can't type into password or card fields, and it can't open `chrome://` or `file://` URLs or close pinned tabs.
- JavaScript dialogs are answered automatically so a page never freezes the agent. An `alert` is acknowledged; `confirm`, `prompt` and "Leave page?" are answered **Cancel**. The agent never says OK on your behalf.
- Page text reaches the agent marked as untrusted, so instructions written on a web page are not followed.

## Install (unpacked)
1. In Olympus Coder, open Settings → Connectors → **Olympus Chrome Extension** → *Open in Chrome* / *Show folder*. Or open `chrome://extensions` yourself.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Keep Olympus Coder running; the extension connects by itself.

## Chrome Web Store build
`npm run package:chrome-ext` writes `dist/olympus-chrome-extension-<version>.zip` with `"key"` removed, because the Store rejects it. The Store assigns its own extension ID. Add that ID to `ALLOWED_EXTENSION_IDS` in `src/main/browserBridge.ts` and ship an app release **before** the listing goes public; otherwise Store installs can't connect. The listing text and permission justifications are in `STORE_LISTING.md`.
