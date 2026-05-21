#!/usr/bin/env sh
# Build a Debian .deb package for engram-mcp (Linux x64).
#
# Prerequisites:
#   - dpkg-deb (install via: sudo apt-get install dpkg)
#   - The compiled binary at dist/bin/engram-mcp-linux-x64
#     (run `npm run build && npm run pack-binary` first)
#
# Usage:
#   sh scripts/linux/build-deb.sh [VERSION]
#
# Output:
#   dist/linux/engram-mcp_<VERSION>_amd64.deb

set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:-$(node -p "require('${ROOT}/package.json').version" 2>/dev/null || echo "0.1.0")}"
ARCH="amd64"
BINARY_SRC="${ROOT}/dist/bin/engram-mcp-linux-x64"
PACKAGE_NAME="engram-mcp"
OUTPUT_DIR="${ROOT}/dist/linux"
PKG_ROOT="${OUTPUT_DIR}/${PACKAGE_NAME}_${VERSION}_${ARCH}"

# ── Validate ─────────────────────────────────────────────────────────────────

if [ ! -f "$BINARY_SRC" ]; then
  echo "Binary not found: $BINARY_SRC"
  echo "Run: npm run build && npm run pack-binary"
  exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb not found. Install with: sudo apt-get install dpkg"
  exit 1
fi

# ── Layout ────────────────────────────────────────────────────────────────────

mkdir -p "$OUTPUT_DIR"
rm -rf "$PKG_ROOT"

# Binary
install -D -m 0755 "$BINARY_SRC" "${PKG_ROOT}/usr/local/bin/engram-mcp"

# systemd user service unit
mkdir -p "${PKG_ROOT}/usr/lib/systemd/user"
cat > "${PKG_ROOT}/usr/lib/systemd/user/engram.service" <<'SERVICE'
[Unit]
Description=EngramMCP local memory server
Documentation=https://engram-mcp.com/docs
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/engram-mcp
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
SERVICE

# Debian control
mkdir -p "${PKG_ROOT}/DEBIAN"
cat > "${PKG_ROOT}/DEBIAN/control" <<CONTROL
Package: ${PACKAGE_NAME}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Raviole Labs <hello@raviolelabs.com>
Section: utils
Priority: optional
Homepage: https://engram-mcp.com
Description: Local-first semantic memory layer for AI agents (MCP server)
 EngramMCP exposes a Model Context Protocol server that gives any AI agent
 persistent, searchable memory. Runs entirely on your machine with Ollama.
CONTROL

# Post-install script: enable the systemd user service hint
cat > "${PKG_ROOT}/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
echo ""
echo "EngramMCP installed to /usr/local/bin/engram-mcp"
echo ""
echo "To run the setup wizard:   engram-mcp install:wizard"
echo "To enable auto-start:      systemctl --user enable --now engram.service"
echo "To check status:           systemctl --user status engram.service"
echo ""
POSTINST
chmod 0755 "${PKG_ROOT}/DEBIAN/postinst"

# Pre-remove: stop service
cat > "${PKG_ROOT}/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
systemctl --user stop engram.service 2>/dev/null || true
systemctl --user disable engram.service 2>/dev/null || true
PRERM
chmod 0755 "${PKG_ROOT}/DEBIAN/prerm"

# ── Build .deb ────────────────────────────────────────────────────────────────

OUTPUT_DEB="${OUTPUT_DIR}/${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKG_ROOT" "$OUTPUT_DEB"

echo ""
echo "Built: $OUTPUT_DEB"
echo "Install with: sudo dpkg -i $OUTPUT_DEB"
echo ""

# Generate checksum
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT_DEB" > "${OUTPUT_DEB}.sha256"
  echo "Checksum: ${OUTPUT_DEB}.sha256"
fi

# Cleanup staging dir
rm -rf "$PKG_ROOT"
