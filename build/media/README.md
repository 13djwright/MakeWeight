# README media rig

The screenshots and GIFs in `docs/media/` are generated, not hand-made, so they can be redone after UI changes.

1. Start a clean demo instance: `MAKEWEIGHT_PORT=8790 python3 -m makeweight --root /tmp/show --no-browser`, point it at a
   Bambu Studio install (Jobs & setup), then `python3 seed_demo.py` builds the "Pothos" showcase robot (components,
   fasteners, printed parts from the meshes listed at the top of the script, weigh-ins, competition log). Run the
   optimizer once from the UI so the results page has a run.
2. `python3 shots.py [name …]` takes each page with Playwright at 2× and writes `<name>-annotated.png` — the callouts
   (element selector, number, text, placement) live in the `SHOTS` table; `annotate.py` draws them.
3. `node rig.js rec '#/route' out.gif "$(cat gif_x.json)"` records a scripted interaction as frames with a drawn cursor,
   then `./mkgif.sh out_frames out.gif 1100` assembles the GIF with ffmpeg (palette per GIF, ~1 MB each).
4. `banner.html` is the header banner; screenshot it at 1200×260, 2×, transparent background, light and dark ink.

Needs Playwright (`NODE_PATH` pointing at a node_modules with it), Pillow, ffmpeg and the Poppins font.
