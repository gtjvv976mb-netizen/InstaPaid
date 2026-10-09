# Handoff: where things stand (9 Oct 2026)

Written at the end of a long Claude Code session so the next session, on any account, starts exactly here.
Read this first, then `README.md` (how it works) and `docs/LAUNCH.md` (the owner's go-live checklist).
Texts written for the owner (Meta forms, App Review notes, captions, the InstaPaid coin): `docs/OWNER-DRAFTS.md`.

## Start here (9 Oct 2026)

Everything is merged: `main` = instapaid.fun, no open PRs. State of the live service:
- **Website launches work**, through the launch lookup table; a first buy is its own transaction after the
  launch (#29, #30). Last live coins: $VEEFRIENDS, $CATCOLLECT (2 Oct).
- **Comment launches have never fired.** Webhook delivery and signatures now work (Meta's Test is parsed,
  #31), but real @mentions are not delivered: the Meta app is most likely not **Live**, and App Review
  (Advanced Access) is in progress by the owner. See "Comment launches: where they stand" below and
  `docs/research/instagram-mentions.md`.
- **The fee payer is low: 0.069 SOL** (9 Oct). Comment launches need > 0.1, the bot > 0.5. Its key
  (`DjEbiv79MFyoYWaaxdbpC4fk6z7dN6Su7w2dL9J8eZHe`) is also used as the owner's own wallet in Phantom. It signed:
  - the $GUNGUN, $NEXYRA, $VEEFRIENDS and $CATCOLLECT website launches, as the launcher's wallet;
  - **the $INSTAPAID coin**: launched on pump.fun on 6 Oct, 03:02 UTC, mint
    `9pBZ76kB69KjkbWh56TDrgnsQTtKdz95VhSFfEj1pump`, with a ~0.2 SOL first buy funded by 0.25 SOL from `LGfWJwhi…`;
    that whole first buy was sold the same day at 17:20 UTC for ~0.193 SOL (not on instapaid.fun's lists);
  - on 8 Oct, a vote and execute on Squads multisig `9gXYdQPTvs1VE5y228EaoPqSY9fCg3MqUw8ZJPx4JGse` (2-of-3:
    `3J57tqAJ…`, `DKyfUy…` and this fee payer; the change, proposed by `3J57tqAJ…`, set a 24 h time lock), and
    0.5 SOL sent to `3J57tqAJ…`.
  Not a theft: `3J57tqAJ…` acts as the owner's wallet (it funds the fee payer and proposed the multisig
  change; it sent 0.3 SOL in on 6 Oct, the extra ~0.2 SOL back was the $INSTAPAID sale). But the server's hot key doubling
  as a personal wallet, and holding a vote in a 2-of-3 multisig, is a risk to raise with the owner.
- **The launcher bot's switches were ON** on 6 Oct (Render logged `bot: fee payer low` and
  `scout: Instagram asked us to slow down (429); pausing 360 min`, which only print while they are on), and it
  cannot scout from Render: Instagram answers 429 every time. Switch both off until a watchlist fallback exists.

The owner's to-do, in order:
1. /admin → Launcher bot: switch **Scouting** and **Auto-launch** off.
2. Top up the fee payer above 0.1 SOL for comment launches.
3. Meta: switch the app to **Live** now (no need to wait for App Review), then comment from a public account
   under a public post and read the `mention:` lines in Render's logs. App Review in parallel: `docs/LAUNCH.md`
   step 14b; what to record is in `docs/OWNER-DRAFTS.md`.
4. Meta Tech Provider access verification, due **30 Nov 2026** (answers in `docs/OWNER-DRAFTS.md`).
5. Wait for Phantom (William, ticket 414019); the post-#30 launch was sent on 2 Oct.
6. Back up `VAULT_MASTER_KEY`; a lawyer on the terms, privacy policy and SEC exposure (now including the
   $INSTAPAID coin and its sold first buy).
7. Still open from before: upload the new profile picture and app icon, tag the creators on the older posts,
   and test one real claim end to end.

Likely next work: when the first real @mention arrives, if the logs say `mention: could not read the post`
(Meta documents `mentioned_comment` only for Facebook Login), the server already has a Facebook Login fallback
(`IG_USER_ID` + `IG_FB_ACCESS_TOKEN`, a Facebook Page linked to @instapaid.official). Read `docs/LAUNCH.md`
Part 4 first: it tells the owner to leave those empty, one Meta app cannot use both logins (so likely a second
Meta app), setting both also moves the auto-poster to the Facebook token, and receiving `mentions` that way
needs `POST /{page-id}/subscribed_apps`, which the server does not do. Code work: a pasted watchlist for the bot.

## The product, in one paragraph

InstaPaid (https://instapaid.fun, Instagram **@instapaid.official**) lets fans launch pump.fun meme coins for
Instagram creators. Only the creator can claim the coin's creator fees. Ways in: comment
`@instapaid.official make a token for this creator` under a public post (the server launches, pays, replies
and posts the coin on @instapaid.official tagging the creator), launch on the website with your own wallet
(Phantom/Solflare), and now the **launcher bot** (below). Operated by **Brylliant Labs Inc.** (Philippines,
Business Verified with Meta). Repo: `gtjvv976mb-netizen/InstaPaid`; the server is `server/` (Node, Express,
SQLite via better-sqlite3), deployed on **Render**, which auto-deploys `main`.

## Everything is merged and live

`main` = what is on instapaid.fun. No open PRs, no uncommitted work. Work happens on the branch the session is
given (1 Oct and before: `claude/epic-curie-4on4v4`; 1–9 Oct: `claude/quirky-pasteur-w4ajnq`); each change is a
PR. The owner merges, or says "MERGE" and the session merges it (after checking it is clean). Render deploys in
about a minute, with ~40 s of 502s (a service with a disk restarts in place). After a merge, restart the branch
from the latest `main`.

What the last two sessions shipped (#19–#28 on `claude/epic-curie-4on4v4`, #29 onward on `claude/quirky-pasteur-w4ajnq`;
PR numbers on gtjvv976mb-netizen/InstaPaid):

| PR | What |
|---|---|
| #19 | Website launches: the wallet signs first, the server co-signs after checking the transaction (`cosignLaunch`, `/api/launch/prepare` + `/api/launch/submit`, `launch_pending`). Done because Phantom support (William, ticket 414019) said their Lighthouse checks want the wallet to sign first. |
| #20 | The auto-poster tags the creator on each post's photo (`user_tags`, falls back to untagged; `post_job.tagged/untagged`). Instagram cannot edit old posts: the owner tags $GUNGUN, $BABYDRAGON, $GRIM by hand. |
| #21–#23 | Pip (the axolotl mascot) went 3D, then (owner disliked it) **2D HD sprites**: Nano Banana Pro drawing, Kling clips on green screen, keyed into `server/public/media/pip-*.webp` (+ `pip-sprites.json`); pipeline in `brand/pip2d/`. |
| #24 | Pip lives **in the page** (stands on element top edges, leaps between them, stomps buttons: visual only, never a real click). `server/public/pip2d.js`, loaded by `mascot.js` with `?v=<hash>`. |
| #25 | **Home page as an app**: a left rail of tabs (Home, How it works, Coins, Creators, Fans, FAQ) + Launch/Claim, one section per screen, no page scroll. `server/public/shell.css` + the tabs code in `home.js`. Hash routing (`/#faq`), Back works, wheel/swipe/PageDown past a section's end goes to the next tab. Without JS the page is stacked. |
| #26 | Big square coin pictures on the Coins tab; **Pip as a platformer**: each tab is a new level he runs into from behind the rail, he bonks rail tabs like "?" blocks for a coin, and visitors cannot steer him (no drag; a click only startles him). |
| #27 | **The launcher bot** (see below). |
| #28 | This handoff, `CLAUDE.md`, and the Higgsfield ad with its sources (`brand/ad/`). |
| #29 | **First buys fit**: the launch lookup table (`npm run lookup-table`), `cosignLaunch` resolves our table only. |
| #30 | **Phantom**: the first buy is its own transaction after the launch (`/api/launch/buy`, `signAndSendTransaction`). |
| #31 | Webhook secrets trimmed, rejection names the secrets that are set; handoff update; the Instagram carousel (`brand/post/`). |
| #32 | Why comment launches have not fired, with sourced research (`docs/research/instagram-mentions.md`). |
| #33–#34 | This handoff ("Start here"), `docs/OWNER-DRAFTS.md`, `CLAUDE.md`; then fixes from a fact-check of them against the code, git and the chain. |

Earlier (before #19): "pump" vanity mint addresses (`mintpool.js`, `mint-grinder.js`), coin pictures served at
`/coins/<mint>.webp` (`coinimages.js`), the `catchUp()` of coins that went live while posting was off,
`/terms`, the new mark (not Instagram's colours), a test that comment launches work under videos and Reels (#14).

## Comment launches: where they stand (6 Oct)

No coin has ever launched from a comment: every live coin has `source = web`. What was found on 6 Oct:
- **Webhook signature (fixed, #31).** Meta's Test for `comments` was rejected: only `IG_APP_SECRET` was set.
  The owner added `META_APP_SECRET`; the Test then reached the server and was parsed (`ignored: not a launch
  request`, as it should be). Both secrets are trimmed now and a rejection names which ones are set.
- **A real @mention produced no webhook at all** (ken.brillantes.98 under @foxstarhong's video, twice).
  Research with sources: `docs/research/instagram-mentions.md`. Most likely cause: the Meta app is not
  **Live**. Instagram's webhooks page says real (non-Test) notifications go only to Live apps, with no
  exception for testers; the dashboard Test skips that check. Next: App settings → Basic (privacy
  `https://instapaid.fun/privacy`, terms `/terms`, data deletion `/data-deletion`, icon, category; Business
  Verification is done) → switch the app to **Live**, then comment again from a public account.
- **Then the post's owner must be readable.** Under Instagram Login the `comments` payload carries the
  comment, the commenter and `media.id`, but not who owns the post (the creator). The server tries
  `mentioned_comment`, `mentioned_media` and `/<media-id>` on graph.instagram.com and logs one line each;
  Meta documents the first two only for Facebook Login, and `/<media-id>` only works for the bot's own
  posts. If all three fail on the first real event (`mention: could not read the post`), the documented
  way is the Facebook Login fallback the server already has: link a Facebook Page to @instapaid.official
  and set `IG_USER_ID` + `IG_FB_ACCESS_TOKEN`.
- If Live alone is not enough, App Review (Advanced Access for `instagram_business_basic` and
  `instagram_business_manage_comments`) is the remaining step; Meta's docs contradict each other on it.

## The launcher bot (#27): live; both switches were ON on 6 Oct, to be switched OFF

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
  switches (kv `scout.crawl`, `scout.launch`; on as of 6 Oct per the logs), limits, seeds box, shortlist, launched list.
- **Render's IP is blocked (6 Oct):** Instagram does not let Render's datacenter IP read profiles. Render's logs show `scout: Instagram asked us to slow down (429); pausing
  360 min` on every try, so the shortlist stays empty from Render. Also `bot: fee payer low` while it was under
  0.5 SOL. It had worked from the Claude
  sandbox. If blocked, /admin shows "Instagram asked us to slow down" and the shortlist stays empty; the
  fallback would be a paid data API or a watchlist the owner pastes.
- History: the owner wanted full automation (no approval per launch, scraping as the source). Claude Code's
  auto-mode safety check blocked writing the auto-launch step twice; it was built once the owner left auto mode
  and approved the edits.

## Next steps the owner was told before 6 Oct ("Start here" wins where they differ)

1. ~~In /admin: add seed creators, turn on **Scouting**, then **Auto-launch**~~ superseded 6 Oct: Instagram
   answers 429 to Render, so keep both switches **off** until a watchlist fallback exists.
2. Back up `VAULT_MASTER_KEY` (it seals every creator vault; losing it loses the fees).
3. Keep the fee payer above 0.1 SOL for comment launches.
4. Upload the new profile picture and app icon (`brand/profile-picture-1080.png`, `brand/app-icon-1024.png`).
5. Tag the creators on the older posts by hand ($GUNGUN, $BABYDRAGON, $GRIM).
6. Test one real claim end to end.
6a. ~~Make the launch lookup table~~ done 1 Oct (`9TA9gGkMNxeEDBSqmK28cFMkPCz49jzz4vgKsecPNeeK`).
7. A lawyer on SEC rules, the terms and the privacy policy (the bot launching coins nobody asked for raises the
   stakes: the site's disclaimers still say coins are "fan-made"; bot coins are labelled separately).

Waiting on others:
- **Phantom** domain review, ticket 414019 (William). On 2 Oct the owner sent him a launch made after #30
  ($VEEFRIENDS, https://instapaid.fun/u/veefriends): 732 bytes with Phantom's Lighthouse program inside it,
  500 under the limit, 9 addresses from the launch table.
  https://solscan.io/tx/3pAUZ7XrRvUpEVcZwgn3fH1Y7pJu886jyWZU2agYEGMoFEPGdeh15uYvDtP2XRLMmPFWydpHsPn8KHdvXYGqbz3a
  Waiting on his answer.
- **Meta App Review**: keep `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_content_publish`, `instagram_business_manage_comments`; remove the rest. On 9 Oct the
  owner was on the form for `instagram_business_manage_comments` (texts: `docs/LAUNCH.md` 14b and
  `docs/OWNER-DRAFTS.md`).

First buys (#29): a launch **with a first buy** was 1,269 bytes, over Solana's 1,232 limit. Website launches
now use the **launch lookup table** (pump.fun's 21 fixed addresses, 1 byte each instead of 32): a first-buy launch
was 931 bytes (since #30 the buy is its own transaction, below). `cosignLaunch` resolves our table and refuses any other. The owner makes the table once, in
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
- Commits as `InstaPaid <sk5ydyhbf2@privaterelay.appleid.com>`; push only to the session's own branch.
- In the old cloud session the working dir was `/home/user/flossify` (a different project): **never touch it**.
- The owner writes short, often all-caps messages; "do it" means build and ship. They like cinematic, lively UI.

## Working on it

```bash
cd server && npm install
CHAIN_TEST=0 npm test        # 198 tests: 193 pass, 5 mainnet tests skipped
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
- Higgsfield (an MCP connector to the owner's Higgsfield account; its tool prefix depends on how it was added:
  `mcp__higg__*` on 30 Sep, `mcp__jdaw__*` on 9 Oct; a new Claude account must connect it again): plan "max", ~1,000 credits left on 30 Sep. Best results
  came from Nano Banana Pro (stills, with a reference image) and Kling 3.0 (pro/4k). Ad details:
  `brand/ad/README.md`. Pip's sprite pipeline: `brand/pip2d/README.md`.

## Marketing made

- `brand/ad/instapaid-ad.mp4`: 21 s vertical ad (Higgsfield), with keyframes, voiceover and the edit script.
- `brand/post/`: six-slide "how it works" Instagram carousel (1080×1350) ending on "comment launches are waiting on
  Meta", made from the ad's keyframes by `make-post.mjs` (`node brand/post/make-post.mjs`). `slide-6-live.jpg` is the
  last slide for once a real comment from a public account has launched a coin ("comment launches are live for
  everyone"); App Review passing alone is not enough (see `docs/OWNER-DRAFTS.md`).
- An X post for @darkbrewdev introducing InstaPaid was written in chat (not saved).
