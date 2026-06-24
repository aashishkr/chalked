#!/bin/bash
# ============================================================
# Excalidraw Desktop — one-time setup script
# Run this once from inside the excalidraw-desktop/ folder:
#   cd excalidraw-desktop && bash setup.sh
# ============================================================
set -e

echo "==> Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install via: brew install node"
  exit 1
fi
echo "    Node $(node -v) ✓"

# Rust — source cargo env first in case it's installed but not on PATH
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

if ! command -v rustc &>/dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
fi
echo "    Rust $(rustc --version) ✓"

echo ""
echo "==> Installing npm dependencies..."
npm install

echo ""
echo "==> Generating proper app icons (requires tauri CLI)..."
# Use a simple SVG as source icon for tauri icon generation
cat > /tmp/app-icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">
  <rect width="100" height="100" rx="20" fill="#6965db"/>
  <path d="M25 75 L50 25 L75 75" stroke="white" stroke-width="8" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="50" cy="55" r="6" fill="white"/>
</svg>
SVG

# Convert SVG to PNG for tauri icon generation (requires ImageMagick or rsvg-convert)
if command -v rsvg-convert &>/dev/null; then
  rsvg-convert -w 512 -h 512 /tmp/app-icon.svg -o /tmp/app-icon.png
  npx tauri icon /tmp/app-icon.png
elif command -v convert &>/dev/null; then
  convert -size 512x512 /tmp/app-icon.svg /tmp/app-icon.png
  npx tauri icon /tmp/app-icon.png
else
  echo "    (Skipping icon gen — no rsvg-convert/ImageMagick found; placeholder icons will be used)"
fi

echo ""
echo "============================================================"
echo "  Setup complete!"
echo ""
echo "  Dev mode (hot reload):"
echo "    npm run tauri dev"
echo ""
echo "  Production build (.app):"
echo "    npm run tauri build"
echo "    Output: src-tauri/target/release/bundle/macos/"
echo ""
echo "  Keyboard shortcuts in the app:"
echo "    ⌘S        Save"
echo "    ⌘⇧S      Save As"
echo "    ⌘O        Open file (replace current tab)"
echo "    ⌘⇧O      Open file in new tab"
echo "============================================================"
