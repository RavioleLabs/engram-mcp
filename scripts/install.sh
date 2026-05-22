#!/usr/bin/env sh
# EngramMCP installer — macOS + Linux
# Usage: curl -fsSL https://engram-mcp.com/install.sh | sh
#
# Environment overrides:
#   ENGRAM_VERSION=v1.2.3   install specific version (default: latest)
#   ENGRAM_DIR=~/.local/bin  override install directory
#   ENGRAM_NO_SERVICE=1      skip service install
#   ENGRAM_NO_MCP_JSON=1     skip mcp.json auto-config
#   ENGRAM_NO_PAIR=1         skip cloud pairing
#   ENGRAM_NO_BROWSER=1      don't open dashboard after install

set -e

REPO="RavioleLabs/engram-mcp"
INSTALL_DIR="${ENGRAM_DIR:-$HOME/.local/bin}"
BINARY_NAME="engram-mcp"
VERSION="${ENGRAM_VERSION:-latest}"
NPM_PKG="@raviolelabs/engram-mcp"
SRC_DIR="$HOME/.engram/src"

START_TS=$(date +%s)
TOTAL_STEPS=8
CURRENT_STEP=0

# ── UX helpers ──────────────────────────────────────────────────────────────

BOLD=$(printf '\033[1m')
DIM=$(printf '\033[2m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')
CYAN=$(printf '\033[36m')
RESET=$(printf '\033[0m')

step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  printf '\n%s▶ Step %d/%d:%s %s%s%s\n' "$CYAN" "$CURRENT_STEP" "$TOTAL_STEPS" "$RESET" "$BOLD" "$1" "$RESET"
}

ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1" ; }
info() { printf '  %s→%s %s\n' "$DIM" "$RESET" "$1" ; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$1" ; }
err() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2 ; }

elapsed_since() {
  echo $(($(date +%s) - $1))
}

# ── Banner ──────────────────────────────────────────────────────────────────

printf '\n'
printf '%s═══════════════════════════════════════════════%s\n' "$DIM" "$RESET"
printf '  %sEngramMCP installer%s\n' "$BOLD" "$RESET"
printf '  %slocal-first semantic memory for AI agents%s\n' "$DIM" "$RESET"
printf '%s═══════════════════════════════════════════════%s\n' "$DIM" "$RESET"

# ── OS / arch detection ──────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)  PLATFORM="darwin" ;;
  Linux)   PLATFORM="linux" ;;
  *)       err "Unsupported OS: $OS" ; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCHNAME="x64" ;;
  arm64|aarch64) ARCHNAME="arm64" ;;
  *)             err "Unsupported arch: $ARCH" ; exit 1 ;;
esac

BINARY="${BINARY_NAME}-${PLATFORM}-${ARCHNAME}"

# ── Step 1: Prerequisites ────────────────────────────────────────────────────

step "Checking prerequisites"
STEP_TS=$(date +%s)

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    info "$1 found: $(command -v $1)"
  else
    err "Missing required command: $1"
    printf '    Install: %s\n' "$2" >&2
    exit 1
  fi
}

require_cmd node "Node.js 22+ (https://nodejs.org)"
require_cmd npm  "npm (bundled with Node.js)"

NODE_VERSION=$(node -v)
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "EngramMCP requires Node.js 22 or newer (you have $NODE_VERSION)"
  info "Upgrade at https://nodejs.org or via nvm: nvm install 22 && nvm use 22"
  exit 1
fi

info "Platform: ${PLATFORM}-${ARCHNAME}"
info "Node:     ${NODE_VERSION}"
info "npm:      $(npm -v)"
ok "Prerequisites OK (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"

mkdir -p "$INSTALL_DIR" "$HOME/.engram"

# ── Step 2: Install engram-mcp from npm ──────────────────────────────────────

step "Installing engram-mcp via npm"
STEP_TS=$(date +%s)

if [ -n "${INSTALL_FROM_FILE:-}" ]; then
  info "Using local binary copy: ${INSTALL_FROM_FILE}"
  cp "$INSTALL_FROM_FILE" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  ok "Local copy installed (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
else
  if npm view "$NPM_PKG" version >/dev/null 2>&1; then
    PUBLISHED_VERSION=$(npm view "$NPM_PKG" version)
    UNPACKED_KB=$(npm view "$NPM_PKG" dist.unpackedSize 2>/dev/null | awk '{printf "%d", $1/1024}')
    info "Package: ${NPM_PKG}@${PUBLISHED_VERSION} (${UNPACKED_KB} KB tarball, ~150 MB on disk with deps)"
    info "Running: npm install -g ${NPM_PKG} --no-audit --no-fund"
    info "(this can take 30-90s — native binaries for SQLite/LanceDB/Whisper)"
    printf '\n'

    # Filter out deprecation noise from transitive deps (uuid, prebuild-install, etc.)
    # Keep errors, real warnings, progress.
    NPM_FILTER='grep -v "npm warn deprecated"'

    if npm install -g "$NPM_PKG" --no-audit --no-fund --loglevel=warn 2>&1 | eval "$NPM_FILTER"; then
      ok "Installed globally (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
    else
      printf '\n'
      warn "Global install failed (likely needs sudo) — using user-local prefix instead"
      mkdir -p "$HOME/.engram/npm"
      info "Running: npm install --prefix ~/.engram/npm ${NPM_PKG} --no-audit --no-fund"
      printf '\n'
      npm install --prefix "$HOME/.engram/npm" "$NPM_PKG" --no-audit --no-fund --loglevel=warn 2>&1 | eval "$NPM_FILTER"
      for bin in engram-mcp engram-mcp-pair engram-mcp-service engram-mcp-rebuild engram-mcp-install; do
        if [ -f "$HOME/.engram/npm/node_modules/.bin/$bin" ]; then
          ln -sf "$HOME/.engram/npm/node_modules/.bin/$bin" "$INSTALL_DIR/$bin"
          info "Linked: ${INSTALL_DIR}/${bin}"
        fi
      done
      ok "Installed to ~/.engram/npm (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
    fi
  else
    # Fallback: git clone + build (for when npm package isn't published yet)
    warn "npm package not found in registry — falling back to git build"
    require_cmd git "git (https://git-scm.com/downloads)"
    if [ -d "$SRC_DIR/.git" ]; then
      info "Updating source at ${SRC_DIR}"
      git -C "$SRC_DIR" fetch --quiet origin
      git -C "$SRC_DIR" reset --quiet --hard origin/main
    else
      info "Cloning from GitHub..."
      rm -rf "$SRC_DIR"
      git clone --depth 1 "https://github.com/${REPO}.git" "$SRC_DIR"
    fi
    printf '\n'
    info "Installing dependencies (this can take a minute)..."
    (cd "$SRC_DIR" && npm install --no-audit --no-fund 2>&1)
    printf '\n'
    info "Building..."
    (cd "$SRC_DIR" && npm run build 2>&1)
    info "Creating launcher: ${INSTALL_DIR}/${BINARY_NAME}"
    cat > "$INSTALL_DIR/$BINARY_NAME" <<EOF
#!/usr/bin/env sh
exec node "$SRC_DIR/dist/scripts/serve.js" "\$@"
EOF
    chmod +x "$INSTALL_DIR/$BINARY_NAME"
    if [ -f "$SRC_DIR/dist/scripts/pair.js" ]; then
      cat > "$INSTALL_DIR/${BINARY_NAME}-pair" <<EOF
#!/usr/bin/env sh
exec node "$SRC_DIR/dist/scripts/pair.js" "\$@"
EOF
      chmod +x "$INSTALL_DIR/${BINARY_NAME}-pair"
    fi
    ok "Built from source (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
  fi
fi

# ── Step 3: PATH setup ───────────────────────────────────────────────────────

step "Setting up PATH"
STEP_TS=$(date +%s)

add_to_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      info "${INSTALL_DIR} already in PATH"
      return 0
      ;;
  esac

  PROFILE=""
  if [ -f "$HOME/.zshrc" ]; then PROFILE="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then PROFILE="$HOME/.profile"
  fi

  if [ -n "$PROFILE" ] && ! grep -q "local/bin" "$PROFILE" 2>/dev/null; then
    printf '\n# Added by EngramMCP installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"
    info "Added ${INSTALL_DIR} to PATH in ${PROFILE}"
    info "Restart your shell or run: source ${PROFILE}"
  fi

  export PATH="$INSTALL_DIR:$PATH"
}

add_to_path
ok "PATH configured (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"

# ── Step 4: Ollama ───────────────────────────────────────────────────────────

step "Installing Ollama (local embeddings — Free tier only)"
STEP_TS=$(date +%s)
info "Why Ollama: local AI runtime that runs the embedding model on your machine."
info "  - Engram pulls 'nomic-embed-text' (~274 MB) to convert text → 768-d vectors"
info "  - Vectors enable semantic recall ('find memories about X' instead of keyword search)"
info "  - 100% local + free + private — your text never leaves your PC"
info "  - Pro users can disable Ollama in the dashboard and use hosted embeddings instead"

install_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    info "Ollama already installed: $(ollama --version 2>&1 | head -1)"
    return 0
  fi

  info "Ollama not found — installing now"

  if [ ! -t 0 ]; then
    info "Non-interactive mode — auto-installing Ollama"
  else
    printf '  Install Ollama now? [Y/n] '
    read -r REPLY
    REPLY="${REPLY:-Y}"
    case "$REPLY" in
      [Yy]*) ;;
      *)
        warn "Skipped — engram-mcp will fail to embed until Ollama is installed"
        info "Install later: https://ollama.com/download"
        return 1
        ;;
    esac
  fi

  printf '\n'
  if [ "$PLATFORM" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      info "Running: brew install ollama (this can take 1-3 min the first time)"
      brew install ollama 2>&1
    else
      info "Homebrew not detected — downloading Ollama.app directly from ollama.com"
      info "URL: https://ollama.com/download/Ollama-darwin.zip (~250 MB)"
      TMPZIP=$(mktemp -t ollama-XXXXXX).zip
      if curl -fL --progress-bar https://ollama.com/download/Ollama-darwin.zip -o "$TMPZIP" 2>&1; then
        info "Extracting to /Applications/Ollama.app"
        if unzip -q -o "$TMPZIP" -d /Applications/ 2>&1; then
          # Remove Gatekeeper quarantine so it runs without prompts
          xattr -d com.apple.quarantine /Applications/Ollama.app 2>/dev/null || true
          rm -f "$TMPZIP"
          info "Launching Ollama.app (creates /usr/local/bin/ollama symlink)"
          open -a Ollama 2>&1 || true
          sleep 5
          # Refresh PATH lookup
          hash -r 2>/dev/null || true
          if ! command -v ollama >/dev/null 2>&1; then
            warn "Ollama installed but binary not in PATH yet"
            info "May need: sudo ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama"
          fi
        else
          err "Failed to extract Ollama.zip"
          rm -f "$TMPZIP"
          return 1
        fi
      else
        err "Failed to download Ollama from https://ollama.com/download/Ollama-darwin.zip"
        info "Manual install: download from https://ollama.com/download and try again"
        return 1
      fi
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    info "Running: curl -fsSL https://ollama.com/install.sh | sh"
    curl -fsSL https://ollama.com/install.sh | sh
  else
    err "Cannot auto-install Ollama — download from https://ollama.com/download"
    return 1
  fi
}

OLLAMA_OK=true
install_ollama || OLLAMA_OK=false
[ "$OLLAMA_OK" = "true" ] && ok "Ollama ready (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"

# ── Step 5: Pull embeddings model ────────────────────────────────────────────

step "Pulling embeddings model (nomic-embed-text, ~274 MB)"
STEP_TS=$(date +%s)

if [ "$OLLAMA_OK" = "true" ]; then
  # Start Ollama server in background if not already running
  if ! pgrep -f 'ollama serve\|/Applications/Ollama' >/dev/null 2>&1; then
    info "Starting Ollama server in background..."
    if [ "$PLATFORM" = "darwin" ] && [ -d "/Applications/Ollama.app" ]; then
      open -a Ollama 2>&1 || true
    else
      (ollama serve >/dev/null 2>&1 &)
    fi
    sleep 3
  fi

  if ollama list 2>&1 | grep -q '^nomic-embed-text'; then
    info "Model nomic-embed-text already pulled"
  else
    info "Running: ollama pull nomic-embed-text"
    printf '\n'
    ollama pull nomic-embed-text 2>&1
  fi
  ok "Embeddings model ready (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
else
  warn "Skipped (Ollama not available)"
fi

# ── Step 6: Install wizard ───────────────────────────────────────────────────

step "Running setup wizard"
STEP_TS=$(date +%s)

if [ -t 0 ]; then
  info "Running: ${BINARY_NAME} install:wizard"
  printf '\n'
  "$INSTALL_DIR/$BINARY_NAME" install:wizard || true
  ok "Wizard finished (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
else
  info "Non-interactive mode — skipping wizard"
  info "Run later: ${BINARY_NAME} install:wizard"
fi

# ── Step 7: Background service + MCP wiring + skill plugin ──────────────────

step "Registering background service + agent config"
STEP_TS=$(date +%s)

install_service() {
  if [ "${ENGRAM_NO_SERVICE:-}" = "1" ]; then
    warn "Skipped (ENGRAM_NO_SERVICE=1)"
    return 0
  fi

  BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"
  mkdir -p "$HOME/.engram/logs"

  if [ "$PLATFORM" = "darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/com.ravolelabs.engram.plist"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ravolelabs.engram</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BINARY_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.engram/logs/engram.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.engram/logs/engram.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.local/bin</string>
  </dict>
</dict>
</plist>
PLIST

    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load -w "$PLIST_FILE"
    info "LaunchAgent: ${PLIST_FILE}"
    info "Loaded and running (auto-starts on login)"

  elif [ "$PLATFORM" = "linux" ]; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    cat > "$SYSTEMD_DIR/engram.service" <<SERVICE
[Unit]
Description=EngramMCP local memory server
After=network.target

[Service]
Type=simple
ExecStart=${BINARY_PATH}
Restart=on-failure
RestartSec=5
StandardOutput=append:${HOME}/.engram/logs/engram.log
StandardError=append:${HOME}/.engram/logs/engram.err
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin

[Install]
WantedBy=default.target
SERVICE

    systemctl --user daemon-reload
    systemctl --user enable --now engram.service
    info "systemd user service installed and started"
  fi
}

install_service

# MCP wiring
add_to_mcp_json() {
  if [ "${ENGRAM_NO_MCP_JSON:-}" = "1" ]; then
    return 0
  fi

  BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"

  for MCP_FILE in "$HOME/.claude/mcp.json" "$HOME/.cursor/mcp.json"; do
    MCP_DIR=$(dirname "$MCP_FILE")
    if [ ! -d "$MCP_DIR" ]; then
      info "$(basename "$MCP_DIR")/ not found — skipping ${MCP_FILE}"
      continue
    fi

    if [ ! -f "$MCP_FILE" ]; then
      printf '{"mcpServers":{"engram":{"command":"%s","args":[]}}}\n' "$BINARY_PATH" > "$MCP_FILE"
      info "Created ${MCP_FILE}"
    elif command -v node >/dev/null 2>&1; then
      node - "$MCP_FILE" "$BINARY_PATH" <<'NODESCRIPT'
const fs = require('fs');
const [,, file, bin] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.engram = { command: bin, args: [] };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
NODESCRIPT
      info "Updated ${MCP_FILE}"
    else
      warn "Could not update ${MCP_FILE} (node missing) — add manually:"
      printf '    "engram": { "command": "%s", "args": [] }\n' "$BINARY_PATH"
    fi
  done
}

add_to_mcp_json

install_engram_skill() {
  if [ ! -f "$HOME/.claude/plugins/installed_plugins.json" ]; then
    info "Claude Code not detected — skipping engram-skill plugin"
    return 0
  fi

  SKILL_VERSION="0.2.0"
  SKILL_DIR="$HOME/.claude/plugins/cache/local/engram-skill/$SKILL_VERSION"
  mkdir -p "$SKILL_DIR"

  if command -v git >/dev/null 2>&1; then
    rm -rf "$SKILL_DIR"
    info "Cloning engram-skill v${SKILL_VERSION}..."
    git clone -q --depth 1 --branch "v$SKILL_VERSION" https://github.com/RavioleLabs/engram-skill "$SKILL_DIR" 2>/dev/null \
      || git clone -q --depth 1 https://github.com/RavioleLabs/engram-skill "$SKILL_DIR"
  fi

  if [ -f "$SKILL_DIR/.claude-plugin/plugin.json" ]; then
    python3 - <<PY
import json, time
path = "$HOME/.claude/plugins/installed_plugins.json"
with open(path) as f:
    data = json.load(f)
data.setdefault("plugins", {})
data["plugins"]["engram-skill@local"] = [{
    "scope": "user",
    "installPath": "$SKILL_DIR",
    "version": "$SKILL_VERSION",
    "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
}]
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
    info "engram-skill plugin installed for Claude Code"
  else
    warn "engram-skill clone failed (network or git issue)"
  fi
}

install_engram_skill
ok "Service + agent wiring done (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"

# ── Step 8: Pair with cloud account ──────────────────────────────────────────

step "Pairing with cloud account"
STEP_TS=$(date +%s)

pair_account() {
  if [ "${ENGRAM_NO_PAIR:-}" = "1" ]; then
    info "Skipped (ENGRAM_NO_PAIR=1)"
    return 0
  fi

  if [ -n "${INVITE_TOKEN:-}" ]; then
    info "Invite token detected: ${INVITE_TOKEN}"
    info "Calling https://api.engram-mcp.com/api/pair/redeem-invite"
    # Capture body and HTTP status separately. No -f flag so we see the actual
    # 4xx body (useful for diagnosing 'invalid_or_expired_invite').
    REDEEM_TMP=$(mktemp -t engram-redeem-XXXXXX)
    HTTP_CODE=$(curl -s -o "$REDEEM_TMP" -w '%{http_code}' -X POST https://api.engram-mcp.com/api/pair/redeem-invite \
      -H "Content-Type: application/json" \
      -d "{\"invite_token\":\"$INVITE_TOKEN\"}" 2>/dev/null)
    REDEEM_RESPONSE=$(cat "$REDEEM_TMP" 2>/dev/null)
    rm -f "$REDEEM_TMP"
    info "HTTP ${HTTP_CODE} — response: $(printf '%s' "$REDEEM_RESPONSE" | head -c 200)"
    if [ "$HTTP_CODE" != "200" ]; then
      warn "Pairing failed (HTTP ${HTTP_CODE}) — engram-mcp installed but not linked to cloud"
      info "Pair later: engram-mcp pair"
      return 0
    fi
    if [ -z "$REDEEM_RESPONSE" ]; then
      warn "API returned empty body (HTTP 200) — pairing skipped"
      info "Pair later: engram-mcp pair"
      return 0
    fi
    # SECURITY: write Python script to a temp file (not heredoc) so we can
    # pipe REDEEM_RESPONSE via stdin without conflict. If we used `python3 -
    # <<'PY'`, the heredoc consumes stdin as the script source and our pipe is
    # silently dropped — sys.stdin.read() returns "" — empty JSON parse fail.
    PAIR_OK=0
    PY_SCRIPT=$(mktemp -t engram-py-XXXXXX).py
    cat > "$PY_SCRIPT" <<'PY'
import json, sys, os, datetime
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as e:
    print(f"PARSE_FAIL: {e}", file=sys.stderr)
    sys.exit(1)
if not isinstance(data, dict):
    print("NOT_DICT", file=sys.stderr); sys.exit(1)
jwt = data.get("jwt", "")
api_key = data.get("api_key", "")
if not isinstance(jwt, str) or not jwt or not isinstance(api_key, str) or not api_key:
    print("MISSING_TOKENS", file=sys.stderr); sys.exit(1)
config_dir = os.path.expanduser("~/.engram")
os.makedirs(config_dir, exist_ok=True)
config_path = os.path.join(config_dir, "config.json")
existing = {}
if os.path.exists(config_path):
    try:
        with open(config_path) as f: existing = json.load(f)
    except Exception:
        pass
existing["engramAccount"] = {
    "jwt": jwt,
    "refreshToken": data.get("refresh_token", "") if isinstance(data.get("refresh_token", ""), str) else "",
    "apiKey": api_key,
    "masterKeySalt": existing.get("engramAccount", {}).get("masterKeySalt", ""),
    "pairedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(config_path, "w") as f:
    json.dump(existing, f, indent=2)
os.chmod(config_path, 0o600)
user_obj = data.get("user", {}) if isinstance(data.get("user", {}), dict) else {}
email = user_obj.get("email", "your account")
if not isinstance(email, str): email = "your account"
print(f"OK: linked to {email}")
PY
    if printf '%s' "$REDEEM_RESPONSE" | python3 "$PY_SCRIPT" > /tmp/engram-pair.out 2>&1; then
      PAIR_OK=1
    fi
    PYTHON_OUT=$(cat /tmp/engram-pair.out 2>/dev/null)
    rm -f /tmp/engram-pair.out "$PY_SCRIPT"
    if [ $PAIR_OK -ne 1 ]; then
      warn "Could not save pair tokens — engram-mcp installed but not linked to cloud"
      printf '  %s\n' "$PYTHON_OUT" | head -3
      info "Pair later: engram-mcp pair"
      return 0
    fi
    info "$PYTHON_OUT"
    info "Tokens saved to ~/.engram/config.json (chmod 600)"

    if [ "${ENGRAM_NO_BROWSER:-}" != "1" ]; then
      DASHBOARD_URL="https://engram-mcp.com/welcome?session=$(python3 -c "
import json, urllib.parse, os
try:
    with open(os.path.expanduser('~/.engram/config.json')) as f:
        cfg = json.load(f)
    jwt = cfg.get('engramAccount', {}).get('jwt', '')
    print(urllib.parse.quote(jwt, safe=''))
except Exception:
    print('')
")"
      if [ -n "$DASHBOARD_URL" ] && [ "$DASHBOARD_URL" != "https://engram-mcp.com/welcome?session=" ]; then
        info "Opening dashboard: https://engram-mcp.com/welcome?session=…"
        if command -v open >/dev/null 2>&1; then
          open "$DASHBOARD_URL"
        elif command -v xdg-open >/dev/null 2>&1; then
          xdg-open "$DASHBOARD_URL" &
        elif command -v start >/dev/null 2>&1; then
          start "$DASHBOARD_URL"
        fi
      fi
    fi
    ok "Paired with cloud (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
    return 0
  fi

  info "No INVITE_TOKEN — installing local-only (MIT, no cloud)"
  info "Pair later: engram-mcp pair"
  ok "Local-only mode (${YELLOW}$(elapsed_since $STEP_TS)s${RESET})"
}

pair_account

# ── Done ─────────────────────────────────────────────────────────────────────

TOTAL_TIME=$(elapsed_since $START_TS)

printf '\n'
printf '%s═══════════════════════════════════════════════%s\n' "$DIM" "$RESET"
printf '  %s✓ EngramMCP installed in %ss%s\n' "$GREEN" "$TOTAL_TIME" "$RESET"
printf '%s═══════════════════════════════════════════════%s\n' "$DIM" "$RESET"
printf '\n'
printf '  %sBinary:%s    %s\n' "$BOLD" "$RESET" "$INSTALL_DIR/$BINARY_NAME"
printf '  %sData dir:%s  ~/.engram\n' "$BOLD" "$RESET"
printf '  %sLogs:%s      ~/.engram/logs/engram.log\n' "$BOLD" "$RESET"
if [ "$OLLAMA_OK" = "false" ]; then
  printf '\n  %sWARN:%s Ollama not installed — run engram-mcp install:wizard to finish setup\n' "$YELLOW" "$RESET"
fi
printf '\n'
printf '  %sTry it now%s — in your AI agent ask:\n' "$BOLD" "$RESET"
printf '    %s"remember that I prefer dark mode"%s\n' "$DIM" "$RESET"
printf '    %s"what do I prefer?"%s\n' "$DIM" "$RESET"
printf '\n'
printf '  %sDashboard:%s  https://engram-mcp.com/dashboard\n' "$BOLD" "$RESET"
printf '  %sDocs:%s       https://engram-mcp.com/docs\n' "$BOLD" "$RESET"
printf '\n'
