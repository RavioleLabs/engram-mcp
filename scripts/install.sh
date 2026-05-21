#!/usr/bin/env sh
# EngramMCP installer — macOS + Linux
# Usage: curl -fsSL https://engram-mcp.com/install.sh | sh
#
# Environment overrides:
#   ENGRAM_VERSION=v1.2.3   install specific version (default: latest)
#   ENGRAM_DIR=~/.local/bin  override install directory
#   ENGRAM_NO_SERVICE=1      skip service install
#   ENGRAM_NO_MCP_JSON=1     skip mcp.json auto-config

set -e

REPO="RavioleLabs/engram-mcp"
INSTALL_DIR="${ENGRAM_DIR:-$HOME/.local/bin}"
BINARY_NAME="engram-mcp"
VERSION="${ENGRAM_VERSION:-latest}"

# ── OS / arch detection ──────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)  PLATFORM="darwin" ;;
  Linux)   PLATFORM="linux" ;;
  *)       echo "Unsupported OS: $OS" && exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCHNAME="x64" ;;
  arm64|aarch64) ARCHNAME="arm64" ;;
  *)             echo "Unsupported arch: $ARCH" && exit 1 ;;
esac

BINARY="${BINARY_NAME}-${PLATFORM}-${ARCHNAME}"

SRC_DIR="$HOME/.engram/src"
NPM_PKG="@raviolelabs/engram-mcp"

# ── Check prerequisites (node + npm) ────────────────────────────────────────

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '✗ Missing required command: %s\n' "$1" >&2
    printf '  Please install %s before running the EngramMCP installer.\n' "$2" >&2
    exit 1
  }
}

require_cmd node "Node.js 22+ (https://nodejs.org)"
require_cmd npm "npm (bundled with Node.js)"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf '✗ EngramMCP requires Node.js 22 or newer (you have %s)\n' "$(node -v)" >&2
  printf '  Upgrade at https://nodejs.org or via nvm: `nvm install 22 && nvm use 22`\n' >&2
  exit 1
fi

printf '\n'
printf '  EngramMCP — local-first memory for AI agents\n'
printf '  Platform: %s-%s · Node: %s\n' "$PLATFORM" "$ARCHNAME" "$(node -v)"
printf '\n'

mkdir -p "$INSTALL_DIR" "$HOME/.engram"

# ── Install via npm (preferred) or fall back to git clone + build ────────────

if [ -n "${INSTALL_FROM_FILE:-}" ]; then
  printf 'Using local binary copy %s...\n' "$INSTALL_FROM_FILE"
  cp "$INSTALL_FROM_FILE" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
else
  # Primary path: install from npm registry (fast, no build needed)
  if npm view "$NPM_PKG" version >/dev/null 2>&1; then
    printf 'Installing %s from npm...\n' "$NPM_PKG"
    # Try global install; fall back to a user-local prefix if EACCES
    if ! npm install -g "$NPM_PKG" 2>/dev/null; then
      printf '  (global install required sudo — using a user-local prefix instead)\n'
      mkdir -p "$HOME/.engram/npm"
      npm install --prefix "$HOME/.engram/npm" "$NPM_PKG"
      # Symlink the bins into INSTALL_DIR
      for bin in engram-mcp engram-mcp-pair engram-mcp-service engram-mcp-rebuild engram-mcp-install; do
        if [ -f "$HOME/.engram/npm/node_modules/.bin/$bin" ]; then
          ln -sf "$HOME/.engram/npm/node_modules/.bin/$bin" "$INSTALL_DIR/$bin"
        fi
      done
    fi
  else
    # Fallback: git clone + build (for when npm package isn't published yet)
    require_cmd git "git (https://git-scm.com/downloads)"
    if [ -d "$SRC_DIR/.git" ]; then
      printf 'npm package not found — updating source at %s...\n' "$SRC_DIR"
      git -C "$SRC_DIR" fetch --quiet origin
      git -C "$SRC_DIR" reset --quiet --hard origin/main
    else
      printf 'npm package not found — cloning from GitHub...\n'
      rm -rf "$SRC_DIR"
      git clone --quiet --depth 1 "https://github.com/${REPO}.git" "$SRC_DIR"
    fi

    printf 'Installing dependencies (this can take a minute)...\n'
    (cd "$SRC_DIR" && npm install --silent --no-audit --no-fund)

    printf 'Building...\n'
    (cd "$SRC_DIR" && npm run build --silent)

    printf 'Linking %s...\n' "$BINARY_NAME"
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
  fi
fi

# ── PATH setup ───────────────────────────────────────────────────────────────

add_to_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac

  PROFILE=""
  if [ -f "$HOME/.zshrc" ]; then PROFILE="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then PROFILE="$HOME/.profile"
  fi

  if [ -n "$PROFILE" ] && ! grep -q "local/bin" "$PROFILE" 2>/dev/null; then
    printf '\n# Added by EngramMCP installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"
    printf 'Added ~/.local/bin to PATH in %s\n' "$PROFILE"
  fi

  export PATH="$INSTALL_DIR:$PATH"
}

add_to_path

# ── Ollama ───────────────────────────────────────────────────────────────────

check_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    printf 'Ollama already installed: %s\n' "$(ollama --version 2>&1 | head -1)"
    return 0
  fi

  printf '\n'
  printf 'Ollama is required for local embeddings (free, private, runs on your machine).\n'

  # Non-interactive (piped install): skip prompt, just notify
  if [ ! -t 0 ]; then
    printf 'Run "engram-mcp install:wizard" after install to set up Ollama.\n'
    return 1
  fi

  printf 'Install Ollama now? [Y/n] '
  read -r REPLY
  REPLY="${REPLY:-Y}"
  case "$REPLY" in
    [Yy]*) ;;
    *)
      printf 'Skipping Ollama install. Run "engram-mcp install:wizard" later to configure.\n'
      return 1
      ;;
  esac

  if [ "$PLATFORM" = "darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install ollama
  elif [ "$PLATFORM" = "linux" ]; then
    curl -fsSL https://ollama.com/install.sh | sh
  else
    printf 'Cannot auto-install Ollama. Download from https://ollama.com/download\n'
    return 1
  fi
}

OLLAMA_OK=true
check_ollama || OLLAMA_OK=false

# ── Install wizard ───────────────────────────────────────────────────────────

if [ -t 0 ]; then
  printf '\nRunning install wizard...\n'
  "$INSTALL_DIR/$BINARY_NAME" install:wizard || true
else
  printf '\nNon-interactive mode. Run "engram-mcp install:wizard" to complete setup.\n'
fi

# ── Background service ───────────────────────────────────────────────────────

install_service() {
  if [ "${ENGRAM_NO_SERVICE:-}" = "1" ]; then
    printf 'Skipping service install (ENGRAM_NO_SERVICE=1).\n'
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
    printf 'LaunchAgent installed and started: %s\n' "$PLIST_FILE"

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
    printf 'systemd user service installed and started.\n'
  fi
}

install_service

# ── mcp.json auto-config ─────────────────────────────────────────────────────

add_to_mcp_json() {
  if [ "${ENGRAM_NO_MCP_JSON:-}" = "1" ]; then
    return 0
  fi

  BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"
  MCP_ENTRY="{\"command\":\"${BINARY_PATH}\",\"args\":[]}"

  for MCP_FILE in "$HOME/.claude/mcp.json" "$HOME/.cursor/mcp.json"; do
    if [ ! -d "$(dirname "$MCP_FILE")" ]; then
      continue
    fi

    # Ask for confirmation in interactive mode
    if [ -t 0 ]; then
      printf '\nAdd engram-mcp to %s? [Y/n] ' "$MCP_FILE"
      read -r REPLY
      REPLY="${REPLY:-Y}"
      case "$REPLY" in
        [Yy]*) ;;
        *) continue ;;
      esac
    fi

    # Create or update the file
    if [ ! -f "$MCP_FILE" ]; then
      printf '{"mcpServers":{"engram":%s}}\n' "$MCP_ENTRY" > "$MCP_FILE"
      printf 'Created %s\n' "$MCP_FILE"
    else
      # Use node if available to safely merge JSON, else just print instructions
      if command -v node >/dev/null 2>&1; then
        node - "$MCP_FILE" "$BINARY_PATH" <<'NODESCRIPT'
const fs = require('fs');
const [,, file, bin] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.engram = { command: bin, args: [] };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('Updated ' + file);
NODESCRIPT
      else
        printf 'Could not auto-update %s (node not found). Add manually:\n' "$MCP_FILE"
        printf '  "engram": { "command": "%s", "args": [] }\n' "$BINARY_PATH"
      fi
    fi
  done
}

add_to_mcp_json

# ── Install engram-skill plugin for Claude Code ──────────────────────────────

install_engram_skill() {
  if [ ! -f "$HOME/.claude/plugins/installed_plugins.json" ]; then
    printf 'ℹ Claude Code not detected — skipping engram-skill install (not needed for Cursor / Continue / other MCP clients; they get instructions via MCP spec).\n'
    return 0
  fi

  printf '📦 Installing engram-skill plugin for Claude Code...\n'

  SKILL_VERSION="0.2.0"
  SKILL_DIR="$HOME/.claude/plugins/cache/local/engram-skill/$SKILL_VERSION"
  mkdir -p "$SKILL_DIR"

  if command -v git >/dev/null 2>&1; then
    rm -rf "$SKILL_DIR"
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
    printf '✓ engram-skill plugin installed at %s\n' "$SKILL_DIR"
  else
    printf '⚠ Could not install engram-skill plugin (network or git issue). engram-mcp still works; the agent will be slightly less optimal at picking it over filesystem grep.\n'
  fi
}

install_engram_skill

# ── Pair with cloud account ──────────────────────────────────────────────────

pair_account() {
  if [ "${ENGRAM_NO_PAIR:-}" = "1" ]; then
    return 0
  fi

  # Zero-friction path: invite token baked in by /install/[token] Pages function
  if [ -n "${INVITE_TOKEN:-}" ]; then
    printf '\n'
    printf '  Redeeming invite token...\n'
    REDEEM_RESPONSE=$(curl -sf -X POST https://api.engram-mcp.com/api/pair/redeem-invite \
      -H "Content-Type: application/json" \
      -d "{\"invite_token\":\"$INVITE_TOKEN\"}" 2>&1)
    REDEEM_EXIT=$?
    if [ $REDEEM_EXIT -ne 0 ] || [ -z "$REDEEM_RESPONSE" ]; then
      printf '  Warning: invite redemption failed (expired or already used).\n'
      printf '  You can still use engram-mcp in local-only mode.\n'
      printf '  To pair later: run '\''engram-mcp pair'\''\n'
    else
      python3 - <<PY
import json, sys, os, datetime
raw = r"""$REDEEM_RESPONSE"""
try:
    data = json.loads(raw)
except Exception as e:
    print(f"  Warning: could not parse redeem response: {e}", file=sys.stderr)
    sys.exit(0)
config_dir = os.path.expanduser("~/.engram")
os.makedirs(config_dir, exist_ok=True)
config_path = os.path.join(config_dir, "config.json")
existing = {}
if os.path.exists(config_path):
    try:
        with open(config_path) as f:
            existing = json.load(f)
    except Exception:
        pass
existing["engramAccount"] = {
    "jwt": data.get("jwt", ""),
    "refreshToken": data.get("refresh_token", ""),
    "apiKey": data.get("api_key", ""),
    "masterKeySalt": existing.get("engramAccount", {}).get("masterKeySalt", ""),
    "pairedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(config_path, "w") as f:
    json.dump(existing, f, indent=2)
os.chmod(config_path, 0o600)
email = data.get("user", {}).get("email", "your account")
print(f"  Paired to {email}")
PY
      # Auto-open dashboard with session JWT for instant login
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
          printf '\n'
          printf '  \360\237\214\220 Opening dashboard in your browser...\n'
          if command -v open >/dev/null 2>&1; then
            open "$DASHBOARD_URL"
          elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$DASHBOARD_URL" &
          elif command -v start >/dev/null 2>&1; then
            start "$DASHBOARD_URL"
          else
            printf '  (could not detect browser opener \342\200\224 visit %s manually)\n' "$DASHBOARD_URL"
          fi
        fi
      fi
      printf '  EngramMCP is now linked. Open https://engram-mcp.com/dashboard to view your memory.\n'
    fi
    return 0
  fi

  # Legacy path: no invite token → skip (user can pair later)
  printf '\n'
  printf '  No invite token found — skipping pairing.\n'
  printf '  Run '\''engram-mcp pair'\'' later to enable cloud features.\n'
}

pair_account

# ── Done ─────────────────────────────────────────────────────────────────────

printf '\n'
printf '  EngramMCP %s installed successfully!\n' "$VERSION"
printf '\n'
printf '  Binary:   %s\n' "$INSTALL_DIR/$BINARY_NAME"
if [ "$OLLAMA_OK" = "false" ]; then
  printf '\n  WARN: Ollama not installed — run "engram-mcp install:wizard" to finish setup.\n'
fi
printf '\n'
printf '  Start manually:  engram-mcp\n'
printf '  Open dashboard:  https://engram-mcp.com/dashboard\n'
printf '  Docs:            https://engram-mcp.com/docs\n'
printf '\n'
