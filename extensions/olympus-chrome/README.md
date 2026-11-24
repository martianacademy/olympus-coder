# Olympus Coder Browser (Chrome MV3 Extension)

Connects your real logged-in Chrome browser directly to **Olympus Coder** so every coding agent (Claude Code, Antigravity, Codex, OpenCode, Ollama, etc.) can browse, inspect, and debug live web pages right in front of you.

## Features
- **Zero-token auto-connect:** Deterministic MV3 Extension ID (`mblgbbfnfhiaphmdkigkkhadealbpkig`) pinned strictly to `127.0.0.1:47819` — rejects all websites and other Chrome extensions with `403`.
- **Live visual browsing:** Animated orange viewport glow, smooth Bezier-gliding virtual cursor, element focus highlight, click ripple, smooth scrolling, and a floating bottom status pill with an instant **Stop** button.
- **Real CDP power (`chrome.debugger`):** Authentic mouse/keyboard input for React, Shadow DOM, and Canvas apps plus live console error and failed network request capture, with automatic idle detach.
- **Safety guardrails:** Auto-groups agent tabs into an orange **Olympus** Chrome tab group, hard-blocks password and payment-card fields, blocks `chrome://`/`file://` URLs, and refuses to close pinned tabs.

## Load in Chrome (20 seconds)
1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extensions/olympus-chrome` folder.
4. Keep Olympus Coder running — the badge turns green **`ON`** automatically.
