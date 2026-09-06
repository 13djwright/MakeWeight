#!/bin/sh
# GRMLN installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | sh
# Downloads the latest release for this machine into ~/Applications/GRMLN (override with GRMLN_DIR) and starts it.
# Files fetched this way carry no macOS quarantine flag, so there is no "unidentified developer" prompt.
set -e
REPO="${GRMLN_REPO:-__REPO__}"
OS=$(uname -s); ARCH=$(uname -m)
case "$OS" in
  Darwin) case "$ARCH" in arm64|aarch64) T=macos-arm64;; *) T=macos-x86_64;; esac; DEFAULT_DIR="$HOME/Applications/GRMLN";;
  Linux)  T=linux-x86_64; DEFAULT_DIR="$HOME/.local/opt/grmln";;
  *) echo "GRMLN: unsupported OS $OS"; exit 1;;
esac
DEST="${GRMLN_DIR:-$DEFAULT_DIR}"
case "$REPO" in __REPO__|"") echo "GRMLN: no repository configured. Run:  GRMLN_REPO=owner/name sh install.sh"; exit 1;; esac
echo "GRMLN: looking up the latest release of $REPO for $T ..."
JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest")
URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*-'"$T"'\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$URL" ] || { echo "GRMLN: no release asset for $T found in $REPO"; exit 1; }
NAME=$(basename "$URL" .zip)
mkdir -p "$DEST"
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t grmln)
echo "GRMLN: downloading $NAME ..."
curl -fL --progress-bar -o "$TMP/grmln.zip" "$URL"
echo "GRMLN: unpacking into $DEST/$NAME ..."
rm -rf "$DEST/$NAME"
unzip -q "$TMP/grmln.zip" -d "$DEST"
rm -rf "$TMP"
chmod +x "$DEST/$NAME"/*.command "$DEST/$NAME"/*.sh "$DEST/$NAME"/python/bin/* 2>/dev/null || true
ln -sfn "$DEST/$NAME" "$DEST/current"
echo "GRMLN: installed. Your data lives in your user data folder; updates can be installed from inside the app."
if [ "$OS" = Darwin ]; then
  echo "GRMLN: starting (a Terminal window opens; keep it open while you use GRMLN). Next time: open \"$DEST/current/GRMLN.command\""
  open -a Terminal "$DEST/current/GRMLN.command"
else
  echo "GRMLN: start it with  \"$DEST/current/grmln.sh\""
  ( cd "$DEST/current" && nohup ./grmln.sh >/dev/null 2>&1 & ) || true
fi
