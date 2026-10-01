#!/usr/bin/env bash
# The ad's edit: four Kling clips (trimmed), captions, the end card, clip sound under the voiceover.
# Needs s0-s3.mp4, last.png, end.png, c0-c3.png and vo.wav here (see README.md). FFMPEG defaults to ffmpeg.
set -euo pipefail
F=${FFMPEG:-ffmpeg}
$F -v error -y \
 -i s0.mp4 -i s1.mp4 -i s2.mp4 -i s3.mp4 \
 -loop 1 -t 5 -i last.png -loop 1 -t 5 -i end.png \
 -i c0.png -i c1.png -i c2.png -i c3.png -i vo.wav \
 -filter_complex "
 [0:v]trim=0:5,setpts=PTS-STARTPTS,scale=1080:-2,crop=1080:1920,fps=30,setsar=1[v0];
 [1:v]trim=0:4.2,setpts=PTS-STARTPTS,scale=1080:-2,crop=1080:1920,fps=30,setsar=1[v1];
 [2:v]trim=0.3:4.1,setpts=PTS-STARTPTS,scale=1080:-2,crop=1080:1920,fps=30,setsar=1[v2];
 [3:v]trim=0:3.4,setpts=PTS-STARTPTS,scale=1080:-2,crop=1080:1920,fps=30,setsar=1[v3];
 [4:v]scale=1080:-2,crop=1080:1920,gblur=sigma=22,fps=30,setsar=1,format=yuva420p[bg];
 [5:v]fps=30,format=yuva420p[ec];
 [bg][ec]overlay=0:0,fade=t=in:st=0:d=0.5,fade=t=out:st=4.4:d=0.6,setsar=1[v4];
 [v0][v1][v2][v3][v4]concat=n=5:v=1:a=0,format=yuv420p[vc];
 [vc][6:v]overlay=0:0:enable='between(t,0.3,2.5)'[o0];
 [o0][7:v]overlay=0:0:enable='between(t,2.7,8.4)'[o1];
 [o1][8:v]overlay=0:0:enable='between(t,9.3,12.9)'[o2];
 [o2][9:v]overlay=0:0:enable='between(t,13.1,16.3)',fade=t=in:st=0:d=0.4[vout];
 [0:a]atrim=0:5,asetpts=PTS-STARTPTS[a0];
 [1:a]atrim=0:4.2,asetpts=PTS-STARTPTS[a1];
 [2:a]atrim=0.3:4.1,asetpts=PTS-STARTPTS[a2];
 [3:a]atrim=0:5.04,asetpts=PTS-STARTPTS,afade=t=out:st=3.4:d=1.6[a3];
 [a0][a1][a2][a3]concat=n=4:v=0:a=1,volume=0.4,apad=whole_dur=21.4,aresample=48000[sfx];
 [10:a]aresample=48000,asplit=3[va][vb][vcc];
 [va]atrim=0.3:15.2,asetpts=PTS-STARTPTS,adelay=200|200[vA];
 [vb]atrim=18.25:19.2,asetpts=PTS-STARTPTS,adelay=16700|16700[vB];
 [vcc]atrim=20.5:23.8,asetpts=PTS-STARTPTS,adelay=17800|17800[vC];
 [vA][vB][vC]amix=inputs=3:normalize=0,volume=1.6[vo];
 [sfx][vo]amix=inputs=2:normalize=0:duration=first,afade=t=out:st=20.6:d=0.8,alimiter=limit=0.95[aout]" \
 -map "[vout]" -map "[aout]" -t 21.4 -c:v libx264 -preset slow -crf 18 -profile:v high -pix_fmt yuv420p \
 -movflags +faststart -c:a aac -b:a 192k instapaid-ad.mp4
