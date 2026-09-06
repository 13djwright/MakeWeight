#!/bin/sh
# Installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | sh
# Downloads the latest release for this machine into ~/Applications/<App> (override with MAKEWEIGHT_DIR) and starts it.
# Files fetched this way carry no macOS quarantine flag, so there is no "unidentified developer" prompt.
# APP / SLUG mirror slicebudget/brand.json — run `python3 build/sync_brand.py` after changing that file.
set -e
APP="MakeWeight"
SLUG="makeweight"
REPO="${MAKEWEIGHT_REPO:-__REPO__}"
OS=$(uname -s); ARCH=$(uname -m)
case "$OS" in
  Darwin) case "$ARCH" in arm64|aarch64) T=macos-arm64;; *) T=macos-x86_64;; esac; DEFAULT_DIR="$HOME/Applications/$APP";;
  Linux)  T=linux-x86_64; DEFAULT_DIR="$HOME/.local/opt/$SLUG";;
  *) echo "$APP: unsupported OS $OS"; exit 1;;
esac
DEST="${MAKEWEIGHT_DIR:-$DEFAULT_DIR}"
case "$REPO" in __REPO__|"") echo "$APP: no repository configured. Run:  MAKEWEIGHT_REPO=owner/name sh install.sh"; exit 1;; esac
echo "$APP: looking up the latest release of $REPO for $T ..."
JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest")
URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*-'"$T"'\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$URL" ] || { echo "$APP: no release asset for $T found in $REPO"; exit 1; }
NAME=$(basename "$URL" .zip)
mkdir -p "$DEST"
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t "$SLUG")
echo "$APP: downloading $NAME ..."
curl -fL --progress-bar -o "$TMP/$SLUG.zip" "$URL"
echo "$APP: unpacking into $DEST/$NAME ..."
rm -rf "$DEST/$NAME"
unzip -q "$TMP/$SLUG.zip" -d "$DEST"
rm -rf "$TMP"
chmod +x "$DEST/$NAME"/*.command "$DEST/$NAME"/*.sh "$DEST/$NAME"/python/bin/* 2>/dev/null || true
ln -sfn "$DEST/$NAME" "$DEST/current"
echo "$APP: installed. Your data lives in your user data folder; updates can be installed from inside the app."
if [ "$OS" = Darwin ]; then
  echo "$APP: starting (a Terminal window opens; keep it open while you use $APP). Next time: open \"$DEST/current/$APP.command\""
  open -a Terminal "$DEST/current/$APP.command"
else
  echo "$APP: start it with  \"$DEST/current/$SLUG.sh\""
  ( cd "$DEST/current" && nohup "./$SLUG.sh" >/dev/null 2>&1 & ) || true
fi
