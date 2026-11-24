#!/bin/sh
# Crea il pacchetto Debian di Editor Video in dist/.
# Uso:  sh packaging/build-deb.sh [versione]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION="${1:-$(cat "$ROOT/packaging/VERSION")}"
NAME=editor-video
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/${NAME}_${VERSION}_all"

# file dell'editor
mkdir -p "$PKG/opt/$NAME"
cp -r "$ROOT/index.html" "$ROOT/app.js" "$ROOT/style.css" "$ROOT/favicon.svg" "$ROOT/lib" "$PKG/opt/$NAME/"
cp "$ROOT/packaging/flags.conf.example" "$PKG/opt/$NAME/"

# comando di avvio, voce di menu, icone
install -Dm755 "$ROOT/packaging/editor-video" "$PKG/usr/bin/$NAME"
install -Dm644 "$ROOT/packaging/editor-video.desktop" "$PKG/usr/share/applications/$NAME.desktop"
install -Dm644 "$ROOT/favicon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/$NAME.svg"
for s in 48 64 128 256; do
  f="$ROOT/packaging/icons/${s}.png"
  [ -f "$f" ] && install -Dm644 "$f" "$PKG/usr/share/icons/hicolor/${s}x${s}/apps/$NAME.png"
done

# permessi standard
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG/opt" -type f -exec chmod 644 {} +

# informazioni del pacchetto
mkdir -p "$PKG/DEBIAN"
SIZE=$(du -sk --exclude=DEBIAN "$PKG" | cut -f1)
cat > "$PKG/DEBIAN/control" <<CTRL
Package: $NAME
Version: $VERSION
Section: video
Priority: optional
Architecture: all
Depends: chromium | google-chrome-stable | chromium-browser | microsoft-edge-stable
Installed-Size: $SIZE
Maintainer: Editor Video <editor-video@localhost>
Description: Editor di foto e video semplice
 Crea video da foto e video: durata delle foto, dissolvenze, animazioni
 delle foto, taglio dei video, tracce musicali ed esportazione in MP4.
 Si apre in una finestra dedicata usando il motore di Chromium.
CTRL
cat > "$PKG/DEBIAN/postinst" <<'SCRIPT'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
SCRIPT
cp "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"
chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"

mkdir -p "$ROOT/dist"
dpkg-deb --root-owner-group -Zxz --build "$PKG" "$ROOT/dist/${NAME}_${VERSION}_all.deb" >/dev/null
echo "Creato: dist/${NAME}_${VERSION}_all.deb"
