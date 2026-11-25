# Chrome Web Store listing — Olympus Coder Browser

This is the copy-paste source for the Developer Dashboard. It is not part of the extension zip.

## Item
- **Name:** Olympus Coder Browser
- **Summary (≤132):** Lets your Olympus Coder AI agents see and use your Chrome, with a live cursor and a Stop button. Talks only to the app on your PC.
- **Category:** Developer Tools
- **Language:** English
- **Homepage:** https://olympus.marsnext.in
- **Support:** https://github.com/martianacademy/olympus-coder/issues
- **Privacy policy URL:** https://github.com/martianacademy/olympus-coder/blob/main/PRIVACY.md (section 4)

## Description
Olympus Coder Browser connects your Chrome to Olympus Coder, the free, open-source desktop app for AI coding agents (Claude Code, Codex, Antigravity, OpenCode, Ollama and more). With it, your agent can test the web app it just built, reproduce a bug, read docs, or fill a form, in your real Chrome with your own logins, while you watch.

What your agent can do:
• Open pages and read their text, links and buttons
• Take screenshots
• See console errors and failed network requests
• Click, type, press keys and shortcuts, choose options, scroll, go back or forward, reload

You stay in control:
• Agent tabs are grouped as "Olympus Coder"
• An orange border, a moving cursor and a status pill show every step
• Stop on the page, or Alt+Shift+S, halts the agent at once
• The toolbar dot shows the state: green while an agent works, yellow when connected, red when the app isn't running

Private by design:
• Connects only to the Olympus Coder app on your own computer (127.0.0.1). No accounts, no analytics, no remote code
• Never reads what you type into password, payment-card or one-time-code fields, and never types into password or card fields
• Page text is marked as untrusted, so instructions written on a page are not followed
• Confirm and "Leave page?" dialogs are always answered Cancel. The agent never clicks OK for you

Requires the free Olympus Coder app: https://github.com/martianacademy/olympus-coder

## Single purpose
Let the AI coding agents in the user's local Olympus Coder app see and operate the user's Chrome tabs on request, with visible feedback and a Stop control.

## Permission justifications
- **tabs:** list the open tabs (title and URL) when the agent asks which pages are open, and open, switch, navigate or close the tab it works in.
- **tabGroups:** keep every tab the agent opens in one "Olympus Coder" group, so the user sees and closes them easily.
- **scripting:** read the page's text and interactive elements, and show the in-page border, cursor and Stop pill in the tab the agent works in.
- **debugger:** send real mouse and keyboard input (needed for React, canvas and shadow-DOM apps), collect that tab's console errors and failed requests, and answer JavaScript dialogs so the page doesn't freeze. It attaches only to the tab the agent is using and detaches after 25 s of inactivity.
- **storage:** remember the local port of the Olympus Coder app.
- **alarms:** reconnect to the app every 30 s after it is restarted.
- **Host permission `<all_urls>`:** the user decides which site the agent works on, so it can be any site. `<all_urls>` is also what `chrome.tabs.captureVisibleTab` requires for screenshots. Pages are read only when the agent calls a tool.
- **Remote code:** No. All code ships in the package.

## Data usage (dashboard checkboxes)
- **Collected:** "Website content" (page text, screenshots) and "Web history" (URLs and titles of open tabs). It is read only when the user's agent calls a tool, and it is sent only to the Olympus Coder app on the same computer.
- **Not collected:** personally identifiable info, health, financial or payment info (card fields are excluded), authentication info (password fields are excluded), personal communications, location, user activity tracking.
- **Certify:**
  - data is not sold to third parties;
  - it is not used or transferred for purposes unrelated to the single purpose;
  - it is not used for creditworthiness or lending.

## Assets (ready, in `store-assets/`)
- **Store icon 128×128:** `icons/icon-128.png`, a dark rounded tile with 96 px artwork and 16 px transparent padding that reads on light and dark backgrounds.
- **Screenshots, 1280×800:**
  - `screenshot-1-working.png`: the agent working on a page, with the edge glow, cursor and status card.
  - `screenshot-2-control.png`: Stop, dialogs, toolbar dot and tab group.
  - `screenshot-3-private.png`: privacy points and the Settings setup card.
- **Small promo tile 440×280:** `promo-tile-440x280.png`.

## Before publishing
1. `npm run package:chrome-ext`, then upload `dist/olympus-chrome-extension-<version>.zip`.
2. Copy the new item ID from the dashboard, add it to `ALLOWED_EXTENSION_IDS` in `src/main/browserBridge.ts`, and release the app.
3. Change Settings → Connectors to point at the Store listing.
4. Only after that app release is out, publish the listing.
