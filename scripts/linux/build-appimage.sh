#!/usr/bin/env sh
# Build an AppImage for engram-mcp (Linux x64).
#
# Prerequisites:
#   - appimagetool (download from https://github.com/AppImage/appimagetool/releases)
#     or: curl -fsSL https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o /usr/local/bin/appimagetool && chmod +x /usr/local/bin/appimagetool
#   - The compiled binary at dist/bin/engram-mcp-linux-x64
#     (run `npm run build && npm run pack-binary` first)
#
# Usage:
#   sh scripts/linux/build-appimage.sh [VERSION]
#
# Output:
#   dist/linux/EngramMCP-<VERSION>-x86_64.AppImage

set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:-$(node -p "require('${ROOT}/package.json').version" 2>/dev/null || echo "0.1.0")}"
BINARY_SRC="${ROOT}/dist/bin/engram-mcp-linux-x64"
OUTPUT_DIR="${ROOT}/dist/linux"
APPDIR="${OUTPUT_DIR}/EngramMCP.AppDir"

# ── Validate ─────────────────────────────────────────────────────────────────

if [ ! -f "$BINARY_SRC" ]; then
  echo "Binary not found: $BINARY_SRC"
  echo "Run: npm run build && npm run pack-binary"
  exit 1
fi

if ! command -v appimagetool >/dev/null 2>&1; then
  echo "appimagetool not found."
  echo "Download from: https://github.com/AppImage/appimagetool/releases"
  echo "Then: chmod +x appimagetool && mv appimagetool /usr/local/bin/"
  exit 1
fi

# ── AppDir layout ─────────────────────────────────────────────────────────────

mkdir -p "$OUTPUT_DIR"
rm -rf "$APPDIR"
mkdir -p "${APPDIR}/usr/bin"

# Binary
cp "$BINARY_SRC" "${APPDIR}/usr/bin/engram-mcp"
chmod +x "${APPDIR}/usr/bin/engram-mcp"

# AppRun entry point
cat > "${APPDIR}/AppRun" <<'APPRUN'
#!/bin/sh
exec "$(dirname "$0")/usr/bin/engram-mcp" "$@"
APPRUN
chmod +x "${APPDIR}/AppRun"

# .desktop file (required by appimagetool)
cat > "${APPDIR}/engram-mcp.desktop" <<'DESKTOP'
[Desktop Entry]
Name=EngramMCP
Comment=Local-first semantic memory layer for AI agents
Exec=engram-mcp
Icon=engram-mcp
Type=Application
Categories=Utility;Development;
Terminal=true
NoDisplay=false
DESKTOP

# Icon (simple SVG placeholder — replace with real 256x256 PNG before release)
if [ -f "${ROOT}/assets/icon.png" ]; then
  cp "${ROOT}/assets/icon.png" "${APPDIR}/engram-mcp.png"
else
  # Create a minimal 1x1 pixel PNG (base64 encoded) as placeholder
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' \
    | base64 -d > "${APPDIR}/engram-mcp.png" 2>/dev/null || \
  touch "${APPDIR}/engram-mcp.png"
fi

# ── Build AppImage ─────────────────────────────────────────────────────────────

OUTPUT_APPIMAGE="${OUTPUT_DIR}/EngramMCP-${VERSION}-x86_64.AppImage"
ARCH=x86_64 appimagetool "$APPDIR" "$OUTPUT_APPIMAGE"

echo ""
echo "Built: $OUTPUT_APPIMAGE"
echo "Run: chmod +x $OUTPUT_APPIMAGE && ./$OUTPUT_APPIMAGE"
echo ""

# Generate checksum
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT_APPIMAGE" > "${OUTPUT_APPIMAGE}.sha256"
  echo "Checksum: ${OUTPUT_APPIMAGE}.sha256"
fi

# Cleanup staging dir
rm -rf "$APPDIR"
