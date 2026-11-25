# Privacy Policy

**Effective date:** November 25, 2026  
**Project:** Olympus Coder (`martianacademy/olympus-coder`)

Olympus Coder is a local-first, open-source desktop and headless workspace for Agent Client Protocol (ACP) coding agents. We do not require an account, and we do not collect analytics, usage telemetry, or advertising data.

## 1. Data Stored on Your Device

All workspace data stays on your own machine (or your own server in headless mode):

- **Shared memory & transcripts:** Stored locally in `~/.olympus` (or the directory configured via `OLYMPUS_HOME`).
- **Application settings & workspace state:** Stored locally in the OS application data folder (`userData`).
- **Credentials & API keys:** Provider API keys entered in Olympus Coder are encrypted locally using the operating system keychain (`safeStorage` on desktop) or stored in owner-only (`0600`) files in headless mode.
- **App lock password:** If you enable an app lock password (via Settings, `--password`, or `OLYMPUS_SERVER_PASSWORD`), it is hashed locally with `scrypt` and is never sent to any external server.

## 2. Telemetry & Tracking

Olympus Coder includes **zero telemetry, zero analytics SDKs, and zero third-party trackers**. We do not collect prompts, source code, file paths, terminal output, or hardware identifiers.

## 3. External Network Connections

Olympus Coder only makes outbound network requests for features you explicitly use:

- **Coding agents & AI providers:** When you run an ACP agent (such as Claude Code, Codex, Antigravity, Gemini CLI, Qwen Code, OpenCode, OpenRouter, or custom providers), your prompts and the project context you share are sent directly from your machine to that provider under their own privacy policy and terms. Local models (such as Ollama) stay entirely on your machine.
- **Voice transcription (optional):** The default engine uses your operating system's built-in dictation. Local `whisper.cpp` runs offline on your machine. Audio is only sent externally if you explicitly choose OpenRouter or a custom transcription server in **Settings → Voice**.
- **Remote phone / browser access (optional):** Same-Wi-Fi LAN mode stays on your local network. If you explicitly turn on the Cloudflare Relay (`olympus-relay.olympus-relay.workers.dev`, or your own self-hosted relay), all traffic between your host and your phone/browser is **end-to-end encrypted with AES-256-GCM**. The relay only forwards encrypted frames and stores room-routing metadata needed to pair devices; it cannot decrypt your chats, files, or terminal sessions. Cloudflare applies per-IP rate limiting to prevent abuse.
- **Claude Agent SDK download (Claude Code only):** The installers do not include Anthropic's proprietary Claude Agent SDK. The first time you start Claude Code, Olympus Coder downloads the exact `@anthropic-ai/claude-agent-sdk` version its open-source adapter needs from the public npm registry (`registry.npmjs.org`). It verifies the package's sha512 checksum and keeps it in the app's data folder. Nothing about you or your projects is sent.
- **Update checks & ACP registry:** Unless you set **Settings → General → Updates** to **Off**, Olympus Coder performs unauthenticated `GET` requests to GitHub Releases (`api.github.com/repos/martianacademy/olympus-coder/releases/latest`) to check for new versions. Searching or installing agents from the ACP Registry fetches public registry metadata and verified release artifacts.

## 4. Olympus Coder Browser (Chrome extension)

The optional Chrome extension lets the coding agents you run in Olympus Coder see and use your Chrome.

- **Where it connects:** only to the Olympus Coder app on the same computer, over `ws://127.0.0.1` (loopback). The app accepts only this extension's ID; websites and other extensions are refused. The extension makes no other network requests and contains no analytics or remote code.
- **What it reads, and when:** only when an agent calls a browser tool. It reads the text, link and button labels, an optional screenshot, and optional recent console errors and failed network requests of the tab the agent works in, plus the list of open tab titles and URLs. Values typed into password, payment-card and one-time-code fields are never read, and the agent cannot type into password or payment-card fields.
- **Where that goes:** to the Olympus Coder app, which hands it to the coding agent you chose for that chat. If that agent uses a cloud AI model, the page content is sent to that provider under its own privacy policy, just like the rest of your prompt. Screenshots are saved on your computer in `~/.olympus/browser-shots/`.
- **What it stores:** nothing about your browsing. It keeps only the local connection port in `chrome.storage.local`.
- **Your control:** agent tabs are grouped as **Olympus Coder**, an orange border and a status pill show while an agent works, and **Stop** on the page (or `Alt+Shift+S`) halts it at once. Removing the extension removes all of this.
- **Not sold, not shared:** data handled by the extension is never sold, never used for advertising or credit decisions, and never transferred to anyone except the AI provider you chose, as described above.

## 5. Deleting Your Data

Because Olympus Coder does not maintain user accounts or cloud databases of your workspaces, you have full control over your data at all times. You can delete all local data by removing `~/.olympus` and the Olympus Coder application data directory on your machine.

## 6. Security & Contact

- Security reports: Please use [GitHub Private Vulnerability Reporting](https://github.com/martianacademy/olympus-coder/security/advisories/new).
- Privacy questions: Open an issue on [github.com/martianacademy/olympus-coder](https://github.com/martianacademy/olympus-coder/issues).
