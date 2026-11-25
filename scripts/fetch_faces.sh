#!/usr/bin/env bash
# Downloads N AI-generated faces (no real people) from thispersondoesnotexist.com
# into faces/face01.jpg ... so the same face can be re-shown and Elo-rated.
# No API key needed. Usage: scripts/fetch_faces.sh [count]
set -euo pipefail
N="${1:-30}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/faces"
mkdir -p "$DIR"
seen=""
i=1
tries=0
while [ "$i" -le "$N" ] && [ "$tries" -lt $((N * 3)) ]; do
  tries=$((tries + 1))
  out="$DIR/$(printf 'face%02d.jpg' "$i")"
  curl -fsSL -A "Mozilla/5.0" "https://thispersondoesnotexist.com/random-person.jpeg?$RANDOM$i" -o "$out.tmp" || { sleep 2; continue; }
  # Must be a JPEG and not a duplicate of one we already have.
  if ! head -c 3 "$out.tmp" | xxd -p | grep -qi '^ffd8ff'; then rm -f "$out.tmp"; sleep 2; continue; fi
  sum="$(md5 -q "$out.tmp" 2>/dev/null || md5sum "$out.tmp" | cut -d' ' -f1)"
  case "$seen" in *"$sum"*) rm -f "$out.tmp"; sleep 2; continue;; esac
  seen="$seen $sum"
  mv "$out.tmp" "$out"
  echo "saved $(basename "$out")"
  i=$((i + 1))
  sleep 1.5   # be polite; the site serves a new face roughly every request
done
echo "done: $((i - 1)) faces in $DIR"
