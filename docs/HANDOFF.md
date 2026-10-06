# Handoff: where things stand (1 Oct 2026)

Written at the end of a long Claude Code session so the next session, on any account, starts exactly here.
Read this first, then `README.md` (how it works) and `docs/LAUNCH.md` (the owner's go-live checklist).

## The product, in one paragraph

InstaPaid (https://instapaid.fun, Instagram **@instapaid.official**) lets fans launch pump.fun meme coins for
Instagram creators. Only the creator can claim the coin's creator fees. Ways in: comment
`@instapaid.official make a token for this creator` under a public post (the server launches, pays, replies
and posts the coin on @instapaid.official tagging the creator), launch on the website with your own wallet
(Phantom/Solflare), and now the **launcher bot** (below). Operated by **Brylliant Labs Inc.** (Philippines,
Business Verified with Meta). Repo: `gtjvv976mb-netizen/InstaPaid`; the server is `server/` (Node, Express,
SQLite via better-sqlite3), deployed on **Render**, which auto-deploys `main`.

## Everything is merged and live

`main` = what is on instapaid.fun. No open PRs, no uncommitted work. Work happens on branch
`claude/epic-curie-4on4v4`; each change is a PR the owner merges (they merge quickly, usually within minutes),
then Render deploys in about a minute. After a PR is merged, restart the branch from the latest `main`.

What this session shipped (PR numbers on gtjvv976mb-netizen/InstaPaid):

| PR | What |
|---|---|
| #19 | Website launches: the wallet signs first, the server co-signs after checking the transaction (`cosignLaunch`, `/api/launch/prepare` + `/api/launch/submit`, `launch_pending`). Done because Phantom support (William, ticket 414019) said their Lighthouse checks want the wallet to sign first. |
| #20 | The auto-poster tags the creator on each post's photo (`user_tags`, falls back to untagged; `post_job.tagged/untagged`). Instagram cannot edit old posts: the owner tags $GUNGUN, $BABYDRAGON, $GRIM by hand. |
| #21–#23 | Pip (the axolotl mascot) went 3D, then (owner disliked it) **2D HD sprites**: Nano Banana Pro drawing, Kling clips on green screen, keyed into `server/public/media/pip-*.webp` (+ `pip-sprites.json`); pipeline in `brand/pip2d/`. |
| #24 | Pip lives **in the page** (stands on element top edges, leaps between them, stomps buttons: visual only, never a real click). `server/public/pip2d.js`, loaded by `mascot.js` with `?v=<hash>`. |
| #25 | **Home page as an app**: a left rail of tabs (Home, How it works, Coins, Creators, Fans, FAQ) + Launch/Claim, one section per screen, no page scroll. `server/public/shell.css` + the tabs code in `home.js`. Hash routing (`/#faq`), Back works, wheel/swipe/PageDown past a section's end goes to the next tab. Without JS the page is stacked. |
| #26 | Big square coin pictures on the Coins tab; **Pip as a platformer**: each tab is a new level he runs into from behind the rail, he bonks rail tabs like "?" blocks for a coin, and visitors cannot steer him (no drag; a click only startles him). |
| #27 | **The launcher bot** (see below). |

Earlier (before #19): "pump" vanity mint addresses (`mintpool.js`, `mint-grinder.js`), coin pictures served at
`/coins/<mint>.webp` (`coinimages.js`), the `catchUp()` of coins that went live while posting was off,
`/terms`, the new mark (not Instagram's colours), comment launches under videos too.

## The launcher bot (#27): live, both switches OFF

- `server/src/scout.js` reads public Instagram profiles the way instagram.com's page does, **no login**
  (`/api/v1/users/web_profile_info/?username=` with header `x-ig-app-id: 936619743392459`): followers, 12
  latest posts, ~50 related accounts. From seeds (`SCOUT_SEEDS`, usernames added in /admin, every creator with a
  coin) it walks related accounts, one profile per `SCOUT_INTERVAL_S` (60 s), scores this week's engagement per
  day (likes + 3×comments, boosted for engagement rate). 429/401/403/redirect → pause 10 min doubling to 6 h.
- `app.locals.autoLaunch` (every `SCOUT_LAUNCH_EVERY_MIN`, 60) launches one coin for the top candidate, through
  the shared `launchPaid()` (same path as comment launches), named/pictured from their most engaged recent post.
  Limits: `SCOUT_MAX_LAUNCHES_PER_DAY` (3), the shared `MAX_SERVER_LAUNCHES_PER_DAY`, fee payer ≥
  `SCOUT_MIN_FEE_PAYER_SOL` (0.5). Skips opted-out (`creator_block`) and creators who already have a coin.
- Honesty: bot coins have `token.origin = 'bot'`; description, post caption ("Made by the InstaPaid bot") and
  site cards ("Made by InstaPaid") never say "Fan-made".
- **/admin → Launcher bot** card (owner logs in with Instagram as @instapaid.official): Scouting and Auto-launch
  switches (kv `scout.crawl`, `scout.launch`; both off), limits, seeds box, shortlist, launched list.
- **Not yet known:** whether Instagram lets Render's datacenter IP read profiles. It worked from the Claude
  sandbox. If blocked, /admin shows "Instagram asked us to slow down" and the shortlist stays empty; the
  fallback would be a paid data API or a watchlist the owner pastes.
- History: the owner wanted full automation (no approval per launch, scraping as the source). Claude Code's
  auto-mode safety check blocked writing the auto-launch step twice; it was built once the owner left auto mode
  and approved the edits.

## Next steps the owner was told (theirs)

1. In /admin: add a few seed creators, turn on **Scouting**, check the shortlist after ~1 h, then turn on
   **Auto-launch**. Keep the fee payer above 0.5 SOL.
2. Back up `VAULT_MASTER_KEY` (it seals every creator vault; losing it loses the fees).
3. Keep the fee payer above 0.1 SOL for comment launches.
4. Upload the new profile picture and app icon (`brand/profile-picture-1080.png`, `brand/app-icon-1024.png`).
5. Tag the creators on the older posts by hand ($GUNGUN, $BABYDRAGON, $GRIM).
6. Test one real claim end to end.
6a. Make the launch lookup table so website first buys work (`docs/LAUNCH.md` step 21a).
7. A lawyer on SEC rules, the terms and the privacy policy (the bot launching coins nobody asked for raises the
   stakes: the site's disclaimers still say coins are "fan-made"; bot coins are labelled separately).

Waiting on others:
- **Phantom** domain review, ticket 414019 (William). On 2 Oct the owner sent him a launch made after #30
  ($VEEFRIENDS, https://instapaid.fun/u/veefriends): 732 bytes with Phantom's Lighthouse program inside it,
  500 under the limit, 9 addresses from the launch table.
  https://solscan.io/tx/3pAUZ7XrRvUpEVcZwgn3fH1Y7pJu886jyWZU2agYEGMoFEPGdeh15uYvDtP2XRLMmPFWydpHsPn8KHdvXYGqbz3a
  Waiting on his answer. That launch was paid from the fee payer's wallet, which is now below the 0.1 SOL
  comment-launch floor: comment launches reply "Launches are paused" until it is topped up.
- **Meta App Review**: keep `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_content_publish`, `instagram_business_manage_comments`; remove the rest.

First buys (#29): a launch **with a first buy** was 1,269 bytes, over Solana's 1,232 limit. Website launches
now use the **launch lookup table** (pump.fun's 21 fixed addresses, 1 byte each instead of 32): a first-buy launch
is 931 bytes. `cosignLaunch` resolves our table and refuses any other. The owner makes the table once, in
Render's Shell: `npm run lookup-table` (shows the plan, sends nothing), then `npm run lookup-table -- --create`
(about 0.005 SOL from the fee payer, saved in kv `launch.lookupTable`, used from the next launch, no restart).
Docs: `docs/LAUNCH.md` step 21a. The owner made it on 1 Oct: `9TA9gGkMNxeEDBSqmK28cFMkPCz49jzz4vgKsecPNeeK`.

Phantom (#30): William (ticket 414019) said launches were still too close to 1,232 bytes for Phantom's Lighthouse
checks and asked to split the transaction and use the table. Website launches now never carry the first buy:
the launch alone is 680 bytes through the table (552 left for Phantom); once the coin is confirmed, the page
asks `/api/launch/buy` for a buy only the launcher signs (606 bytes) and hands it to the wallet's
`signAndSendTransaction`. Both passed mainnet simulation. The buy is no longer atomic with the create.

## Rules that hold (from the owner, over many rounds)

- Never paste secrets; never give Meta the @instapaid.official password.
- No Apple logo or "iPhone" wording on the site (a test checks `index.html`, `home.css`, `home.js`).
- Pip never really clicks, follows a link or submits anything: visual effects only. Visitors cannot steer him.
- Mainnet actions (lookup table, anything spending SOL outside the existing launch paths) need the owner's yes.
- Don't work around Claude Code safety-check denials; stop and explain.
- Commits as `InstaPaid <sk5ydyhbf2@privaterelay.appleid.com>`; push only to `claude/epic-curie-4on4v4`.
- In the old cloud session the working dir was `/home/user/flossify` (a different project): **never touch it**.
- The owner writes short, often all-caps messages; "do it" means build and ship. They like cinematic, lively UI.

## Working on it

```bash
cd server && npm install
CHAIN_TEST=0 npm test        # 192 tests: 187 pass, 5 mainnet tests skipped
```
- Static assets are cache-busted with `?v=<sha256[:8]>`; `test/pages.test.js` checks the hashes. After editing
  `public/pip2d.js`, update its hash in `public/mascot.js`
  (`h=$(sha256sum public/pip2d.js | cut -c1-8)`, then replace `pip2d.js?v=...`).
- Browser checks: Chromium at `/opt/pw-browsers/chromium`, Playwright from the global npm root; run against a
  local server from `start()` in `test/helpers.js` (the sandbox proxy blocks the live site's modules in headless
  runs). `window.PIP_DEBUG = 1` before load exposes `window.__pip` (grounds, current ground).
- Every home tab was measured to fit one screen at 1440×900, 1366×768, 1280×720, 1024×768 and 390×844
  (Coins/FAQ scroll a little inside the section at 360×740).
- ffmpeg: `pip install imageio-ffmpeg`, then `python3 -c 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'`.
- Higgsfield (MCP `mcp__higg__*`): the owner's account, plan "max", ~1,000 credits left on 30 Sep. Best results
  came from Nano Banana Pro (stills, with a reference image) and Kling 3.0 (pro/4k). Ad details:
  `brand/ad/README.md`. Pip's sprite pipeline: `brand/pip2d/README.md`.

## Marketing made

- `brand/ad/instapaid-ad.mp4`: 21 s vertical ad (Higgsfield), with keyframes, voiceover and the edit script.
- `brand/post/`: six-slide "how it works" Instagram carousel (1080×1350) ending on "comment launches are waiting on
  Meta", made from the ad's keyframes by `make-post.mjs` (`node brand/post/make-post.mjs`). Re-run it after App
  Review passes and swap the last slide for a "live now" one.
- An X post for @darkbrewdev introducing InstaPaid was written in chat (not saved).
