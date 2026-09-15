#!/bin/bash
# mkgif.sh <frames_dir> <out.gif> [width]
set -e
D=$1; OUT=$2; W=${3:-1100}
ffmpeg -y -loglevel error -f concat -safe 0 -i "$D/list.txt" -vf "fps=15,scale=$W:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$OUT"
ls -la "$OUT" | awk '{print $5/1048576 " MB"}'
