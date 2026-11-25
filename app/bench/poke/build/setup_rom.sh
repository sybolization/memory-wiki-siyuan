#!/usr/bin/env bash
# Build vanilla pret/pokered ROM inside WSL. Logs every phase with progress.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(cd "$SCRIPT_DIR/.." && pwd)/rom"
say(){ echo "[$(date +%H:%M:%S)] $*"; }

say "phase 1/6 apt deps"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/tmp/apt-update.log 2>&1 || { say "apt update FAILED"; tail -5 /tmp/apt-update.log; exit 1; }
apt-get install -y -qq git make gcc bison pkg-config libpng-dev python3 curl xz-utils >/tmp/apt-install.log 2>&1 \
  || { say "apt install FAILED"; tail -20 /tmp/apt-install.log; exit 1; }
say "deps ok: gcc $(gcc -dumpversion) git $(git --version | awk '{print $3}')"

say "phase 2/6 rgbds 1.0.4"
if ! command -v rgbasm >/dev/null 2>&1; then
  mkdir -p /opt/rgbds
  curl -sSL -o /tmp/rgbds.tar.xz https://github.com/gbdev/rgbds/releases/download/v1.0.4/rgbds-linux-x86_64.tar.xz \
    || { say "rgbds download FAILED"; exit 1; }
  tar -xJf /tmp/rgbds.tar.xz -C /opt/rgbds || { say "rgbds extract FAILED"; exit 1; }
  find /opt/rgbds -type f -name 'rgb*' -perm -u+x -exec cp {} /usr/local/bin/ \;
  chmod +x /usr/local/bin/rgb*
fi
say "rgbasm: $(rgbasm -V 2>&1 | head -1)"

say "phase 3/6 clone pret/pokered"
if [ ! -d /opt/pokered/.git ]; then
  rm -rf /opt/pokered
  git clone --depth 1 https://github.com/pret/pokered /opt/pokered >/tmp/clone.log 2>&1 \
    || { say "clone FAILED"; tail -10 /tmp/clone.log; exit 1; }
fi
say "clone ok: $(git -C /opt/pokered rev-parse --short HEAD)"

say "phase 4/6 make (long; progress every 10s below)"
cd /opt/pokered || exit 1
: > /tmp/pokered-make.log
make -j"$(nproc)" > /tmp/pokered-make.log 2>&1 &
mpid=$!
while kill -0 "$mpid" 2>/dev/null; do
  echo "[progress] $(wc -l < /tmp/pokered-make.log) log lines; asm:$(grep -c rgbasm /tmp/pokered-make.log) gfx:$(grep -c rgbgfx /tmp/pokered-make.log)"
  sleep 10
done
wait "$mpid"; rc=$?
say "make exit=$rc"
tail -25 /tmp/pokered-make.log

say "phase 5/6 verify artifacts"
ls -l pokered.gbc pokered.sym pokered.map 2>&1
say "sha1 actual:   $(sha1sum pokered.gbc | awk '{print $1}')"
say "sha1 expected: ea9bcae617fdf159b045185467ae58b2e4a48b9a"
wc -l < pokered.sym | sed 's/^/sym lines: /'
for s in wTileMap wOverworldMap wCurMap wXCoord wYCoord wObtainedBadges wPartyCount wPartyMon1Level wPlayerMoney wBattleType; do
  grep -q " $s\$" pokered.sym && echo "  sym OK  $s" || echo "  sym MISSING  $s"
done

say "phase 6/6 copy to windows"
mkdir -p "$DEST"
cp -f pokered.gbc pokered.sym pokered.map "$DEST"/ || { say "copy FAILED"; exit 1; }
sha1sum pokered.gbc > "$DEST/pokered.gbc.sha1"
say "done: $(ls -l "$DEST" | tail -n +2 | awk '{print $9"("$5")"}' | tr '\n' ' ')"
