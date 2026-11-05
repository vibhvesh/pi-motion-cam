#!/usr/bin/env bash
# Re-download and cut the YouTube test clips listed in tests/data/test_clips_manifest.csv (plates + other modules).
# The videos are NOT in this repo (copyright: Standard YouTube License except where noted). For private testing only.
# Usage: tests/fetch_plate_samples.sh [OUT_DIR] [MODULE]   e.g.  tests/fetch_plate_samples.sh ~/pmc-data plates
# Needs: yt-dlp (pip install yt-dlp) and ffmpeg. If YouTube asks for a bot check, try: --extractor-args "youtube:player_client=web_safari"
set -euo pipefail
OUT="${1:-$HOME/pi-motion-cam-data}"; ONLY="${2:-}"
MAN="$(cd "$(dirname "$0")" && pwd)/data/test_clips_manifest.csv"
command -v yt-dlp >/dev/null || { echo "Install yt-dlp: pip install yt-dlp"; exit 1; }
command -v ffmpeg >/dev/null || { echo "Install ffmpeg: sudo apt install ffmpeg"; exit 1; }
mkdir -p "$OUT/raw"
python3 - "$MAN" "$ONLY" <<'PY' | while IFS=$'\t' read -r module clip id start end; do
import csv, sys
for r in csv.DictReader(open(sys.argv[1])):
    if not sys.argv[2] or r["module"] == sys.argv[2]:
        print("\t".join([r["module"], r["clip"], r["youtube_id"], r["start_s"], r["end_s"]]))
PY
  raw="$OUT/raw/$id.mp4"; dst="$OUT/clips/$module/$clip"; mkdir -p "$OUT/clips/$module"
  [ -f "$dst" ] && { echo "have $dst"; continue; }
  [ -f "$raw" ] || yt-dlp -q --no-warnings -f "bv*[height<=720][ext=mp4]/b[height<=720]" -o "$raw" "https://www.youtube.com/watch?v=$id" || { echo "FAILED download $id"; continue; }
  ffmpeg -loglevel error -y -ss "$start" -to "$end" -i "$raw" -an -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 23 -preset veryfast "$dst" </dev/null
  echo "cut $dst ($start-$end s)"
done
echo "Done. Test one: ./venv/bin/python main.py --source $OUT/clips/plates/P03_india_road_level_day.mp4 --out /tmp/t1"
