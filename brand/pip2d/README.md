# Pip in 2D

The roaming Pip on the site (`server/public/pip2d.js`) plays sprite sheets made from these.

1. `pip-2d-1024.png`: Pip drawn in HD 2D with Nano Banana Pro (Higgsfield), from the 3D Pip.
2. `pip-front-green-1024.png` and `pip-side-green-1024.png`: the same Pip on a chroma-key green
   background, facing the viewer and walking to the right.
3. Each move is a 5-second Kling v3.0 (pro, 1:1, no sound) clip on Higgsfield, with the green image
   as **both** the start and the end frame, so every move loops and starts and ends in the same pose:
   walk (side image), idle, wave, jump (two small hops, fully in frame), dance, press, look, cheer.
4. `make-sprites.mjs` keys the clips (green-dominance, so dark green shadows go too), crops every
   front clip to one shared box (the walk to its own), and writes 10 fps sheets 260 px tall to
   `server/public/media/pip-<move>.webp` with `pip-sprites.json`. Needs `pip install imageio-ffmpeg`.
   Put the clips in `clips/<move>.mp4` and run `node make-sprites.mjs out`, then add `src` (the crop
   height: 1370 front, 1306 walk) and `v` (hash of the sheets) to the json, as the caching test checks.
