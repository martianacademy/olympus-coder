#!/usr/bin/env sh
# Olympus Coder Headless Server — 1-Line Installer for Linux VPS & macOS
# Runs 100% in pure Node.js (zero Electron, zero GUI/X11) and exposes the full Olympus Coder UI
# over E2EE Cloudflare Relay / LAN / Tailscale so you can control all 18+ coding CLIs from your phone.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/martianacademy/olympus-coder/main/scripts/install-server.sh | sh
#   OLYMPUS_SERVER_TARBALL=/path/to/olympus-server.tar.gz sh scripts/install-server.sh

set -eu

REPO_SLUG="${OLYMPUS_REPO:-martianacademy/olympus-coder}"
GIT_REF="${OLYMPUS_REF:-main}"
OLYMPUS_HOME="${OLYMPUS_HOME:-$HOME/.olympus}"
INSTALL_DIR="${OLYMPUS_SERVER_DIR:-$OLYMPUS_HOME/server-bin}"
OLYMPUS_BIN="$OLYMPUS_HOME/bin"
LOCAL_BIN="${OLYMPUS_BIN_DIR:-$HOME/.local/bin}"
NODE_RUNTIME_DIR="$OLYMPUS_HOME/runtimes/node"
NODE_LTS_VERSION="${OLYMPUS_NODE_VERSION:-22.15.0}"

printf "\n🌋 Installing Olympus Coder Headless Server (%s)...\n\n" "$REPO_SLUG"

if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  printf "✗ Error: curl and tar are required.\n" >&2
  exit 1
fi

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
case "$OS_NAME" in
  Darwin) PLAT_OS="darwin" ;;
  Linux)  PLAT_OS="linux" ;;
  *) printf "✗ Unsupported OS: %s\n" "$OS_NAME" >&2; exit 1 ;;
esac
case "$ARCH_NAME" in
  arm64|aarch64) PLAT_ARCH="arm64" ;;
  x86_64|amd64)  PLAT_ARCH="x64" ;;
  *) printf "✗ Unsupported CPU: %s\n" "$ARCH_NAME" >&2; exit 1 ;;
esac

# 1. Find Node.js >= 22 or bootstrap standalone Node 22 LTS into ~/.olympus/runtimes/node (no sudo!)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  CAND="$(command -v node)"
  if "$CAND" -e 'const [m]=process.versions.node.split(".").map(Number);process.exit(m>=22?0:1)' >/dev/null 2>&1; then
    NODE_BIN="$CAND"
  fi
fi

if [ -z "$NODE_BIN" ] && [ -x "$NODE_RUNTIME_DIR/bin/node" ]; then
  if "$NODE_RUNTIME_DIR/bin/node" -e 'const [m]=process.versions.node.split(".").map(Number);process.exit(m>=22?0:1)' >/dev/null 2>&1; then
    NODE_BIN="$NODE_RUNTIME_DIR/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  NODE_URL="https://nodejs.org/dist/v${NODE_LTS_VERSION}/node-v${NODE_LTS_VERSION}-${PLAT_OS}-${PLAT_ARCH}.tar.gz"
  printf "⚡ Bootstrapping standalone Node.js v%s (%s-%s)...\n" "$NODE_LTS_VERSION" "$PLAT_OS" "$PLAT_ARCH"
  TMP_NODE="$(mktemp -d)"
  curl -fsSL --connect-timeout 10 --max-time 180 "$NODE_URL" -o "$TMP_NODE/node.tar.gz"
  rm -rf "$NODE_RUNTIME_DIR"
  mkdir -p "$NODE_RUNTIME_DIR"
  tar -xzf "$TMP_NODE/node.tar.gz" -C "$NODE_RUNTIME_DIR" --strip-components=1
  rm -rf "$TMP_NODE"
  NODE_BIN="$NODE_RUNTIME_DIR/bin/node"
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

TMP_STAGE="$(mktemp -d)"
trap 'rm -rf "$TMP_STAGE"' EXIT

mkdir -p "$TMP_STAGE/pkg"

# 2. Obtain headless server bundle: local tarball > GitHub Release prebuilt > source build fallback
INSTALLED_MODE=""
if [ -n "${OLYMPUS_SERVER_TARBALL:-}" ]; then
  printf "📦 Unpacking local server bundle: %s\n" "$OLYMPUS_SERVER_TARBALL"
  tar -xzf "$OLYMPUS_SERVER_TARBALL" -C "$TMP_STAGE/pkg" --strip-components=1
  INSTALLED_MODE="local-tarball"
else
  # Try latest GitHub Release prebuilt tarball matching this OS/arch
  RELEASE_API="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
  ASSET_URL="$(curl -fsSL --connect-timeout 8 --max-time 20 "$RELEASE_API" 2>/dev/null | "$NODE_BIN" -e '
    const raw = require("fs").readFileSync(0, "utf8");
    try {
      const r = JSON.parse(raw);
      const suffix = "-" + process.argv[1] + "-" + process.argv[2] + ".tar.gz";
      const hit = (r.assets || []).find(a => a.name && a.name.startsWith("olympus-server-") && a.name.endsWith(suffix));
      if (hit && hit.browser_download_url) process.stdout.write(hit.browser_download_url);
    } catch {}
  ' "$PLAT_OS" "$PLAT_ARCH" || true)"

  if [ -n "$ASSET_URL" ]; then
    printf "⬇️  Downloading prebuilt headless server (%s-%s)...\n" "$PLAT_OS" "$PLAT_ARCH"
    curl -fsSL --connect-timeout 10 --max-time 180 "$ASSET_URL" -o "$TMP_STAGE/server.tar.gz"
    tar -xzf "$TMP_STAGE/server.tar.gz" -C "$TMP_STAGE/pkg" --strip-components=1
    INSTALLED_MODE="prebuilt-release"
  else
    printf "🔧 No prebuilt tarball for %s-%s yet — building headless server from %s@%s...\n" "$PLAT_OS" "$PLAT_ARCH" "$REPO_SLUG" "$GIT_REF"
    SRC_URL="https://github.com/${REPO_SLUG}/archive/${GIT_REF}.tar.gz"
    curl -fsSL --connect-timeout 10 --max-time 180 "$SRC_URL" -o "$TMP_STAGE/src.tar.gz"
    mkdir -p "$TMP_STAGE/src"
    tar -xzf "$TMP_STAGE/src.tar.gz" -C "$TMP_STAGE/src" --strip-components=1
    (
      cd "$TMP_STAGE/src"
      ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts --no-audit --no-fund
      npm run build:server
      node scripts/package-server.mjs
    )
    BUILT_TGZ="$(ls "$TMP_STAGE/src/dist"/olympus-server-*.tar.gz | head -n 1)"
    tar -xzf "$BUILT_TGZ" -C "$TMP_STAGE/pkg" --strip-components=1
    INSTALLED_MODE="source-build"
  fi
fi

# If a portable tarball without node_modules was supplied, install its 5 lightweight runtime deps now
if [ ! -d "$TMP_STAGE/pkg/node_modules" ]; then
  printf "📦 Installing headless runtime dependencies...\n"
  (cd "$TMP_STAGE/pkg" && npm install --omit=dev --no-audit --no-fund)
fi

mkdir -p "$(dirname "$INSTALL_DIR")" "$OLYMPUS_BIN" "$LOCAL_BIN"
rm -rf "$INSTALL_DIR"
mv "$TMP_STAGE/pkg" "$INSTALL_DIR"

write_shim() {
  TARGET="$1"
  {
    printf '#!%s\n' "$(command -v sh)"
    printf 'set -e\n'
    printf 'if [ -x "%s" ]; then\n' "$NODE_BIN"
    printf '  exec "%s" "%s/out/server/index.mjs" "$@"\n' "$NODE_BIN" "$INSTALL_DIR"
    printf 'fi\n'
    printf 'exec node "%s/out/server/index.mjs" "$@"\n' "$INSTALL_DIR"
  } > "$TARGET"
  chmod +x "$TARGET"
}

write_shim "$OLYMPUS_BIN/olympus-server"
if [ "$LOCAL_BIN" != "$OLYMPUS_BIN" ]; then
  write_shim "$LOCAL_BIN/olympus-server"
fi

case ":$PATH:" in
  *":$OLYMPUS_BIN:"*) ;;
  *)
    for rc_name in ".zshrc" ".bashrc" ".bash_profile"; do
      if [ -f "$HOME/$rc_name" ] && ! grep -Fq '.olympus/bin' "$HOME/$rc_name"; then
        printf '\n# Olympus Coder\nexport PATH="$HOME/.local/bin:$HOME/.olympus/bin:$PATH"\n' >> "$HOME/$rc_name"
        printf "✓ Added ~/.local/bin and ~/.olympus/bin to ~/%s\n" "$rc_name"
      fi
    done
    ;;
esac

printf "\n✓ Installed Olympus Coder Headless Server (%s) to %s\n" "$INSTALLED_MODE" "$INSTALL_DIR"
printf "✓ Command linked: olympus-server (also works via: oly serve)\n\n"
printf "Next steps:\n"
printf "  1) Start with E2EE phone/browser QR:  olympus-server serve --relay --project .\n"
printf "  2) Install as Linux background service:\n"
printf "       mkdir -p ~/.config/systemd/user\n"
printf "       olympus-server serve --relay --print-systemd > ~/.config/systemd/user/olympus-server.service\n"
printf "       systemctl --user enable --now olympus-server\n\n"
