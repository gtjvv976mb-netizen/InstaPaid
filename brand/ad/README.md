# The InstaPaid ad (30 Sep 2026)

`instapaid-ad.mp4`: 21.4 s, 1080×1920 (9:16, Reels/TikTok), H.264 + AAC, voiceover and burned-in captions.

| Time | Shot | Caption |
|---|---|---|
| 0–5.0 s | Pip peeks over a phone showing a bread post (`keyframes/shot1.jpg`) | See a post you love? |
| 5.0–9.2 s | A coin bursts out of the phone, Pip leaps (`shot2.jpg`) | Comment: @instapaid.official make a token for this creator |
| 9.2–13.0 s | Pip hugs the spinning coin (`shot3.jpg`) | We launch a coin, named from the post |
| 13.0–16.4 s | Coins pour into a chest, Pip in a crown (`shot4.jpg`) | Only the creator can claim its fees |
| 16.4–21.4 s | End card: mark, wordmark, "One comment. A coin for the creator.", instapaid.fun, small print | |

## How it was made (Higgsfield)

- **Stills:** Nano Banana Pro, 2K, 9:16, with Pip's drawing (`brand/pip2d/pip-2d-1024.png`, Higgsfield media
  `ef4889e3-08cb-4316-aa98-fc61f622b5c2`) as the image reference. Jobs: shot1 `26fb921c-5521-4efb-a756-8784041a448c`,
  shot2 `b511b5b3-fd02-423a-a1f5-40419c6978c6`, shot3 `ae0e3837-4ded-4e58-844a-9839afe7ee6c`,
  shot4 `2df02250-7889-48e1-b031-a3d933bde738`.
- **Video:** Kling 3.0, mode `4k`, sound on, 5 s each, start image = the still. Jobs: shot1
  `4d5f27f8-10e5-49d7-a6f8-dd6963cf01f6`, shot2 `f91225c6-7929-49b9-a5c8-33bf22496e57`,
  shot3 `d21372c0-eec6-4d56-a9a0-a1ea51425206`, shot4 `1bec43b4-e123-4ae5-b880-ba2c6448fea6`.
  Kling pushed a preset ("IN THE DARK") once: resubmit with `declined_preset_id: 24bae836-2c4a-48e0-89b6-49fcc0b21612`.
- **Voiceover:** Seed Audio, preset voice "Ainsley" (`731b4ffe-e95e-59f4-8c00-81608936091f`), job
  `9522e531-64d7-49ca-bf9e-a74ba1a25254` (`voiceover.wav`, 24 s with pauses). Script: "See a post you love?
  Comment: at instapaid dot official, make a token for this creator. We launch a coin, named from the post.
  And only the creator can claim its fees. InstaPaid. One comment. A coin for the creator."
- **Cost:** about 150 credits (4k Kling = 30 a clip). About 1,000 credits were left on 30 Sep.

The 4K clips (2152×3852) are not in the repo (about 60 MB); they stay in the Higgsfield account under the job ids
above. Without the Higgsfield account, `keyframes/` and `instapaid-ad.mp4` are what is left.

## Re-editing

`overlays.mjs` draws the caption boxes (`c0–c3.png`) and the end card (`end.png`) with sharp (DejaVu Sans Bold).
Put the four clips beside it as `s0–s3.mp4`, the voiceover as `vo.wav`, take `last.png` from shot 4 at 4.9 s
(`ffmpeg -ss 4.9 -i s3.mp4 -frames:v 1 last.png`), then `bash edit.sh`.
