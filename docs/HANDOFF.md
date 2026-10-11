# Handoff: where things stand (11 Oct 2026)

Updated from GitHub and the interrupted Claude continuation so the next session, on any account, starts here.
Read this first, then `README.md` (how it works) and `docs/LAUNCH.md` (the owner's go-live checklist).
Texts written for the owner (Meta forms, App Review notes, captions, the InstaPaid coin): `docs/OWNER-DRAFTS.md`.

## Start here (11 Oct 2026)

**#35 is merged** (GitHub confirms merge commit `472458728bbfc8d8f9760f2652249b41c782e8df`, merged 10 Oct 2026).
Its /admin event counters, retry controls, launcher watchlist and Facebook Login fallback are on `main`.
Deployment health was not rechecked during this handoff update.

The owner's latest Meta dashboard report in the interrupted continuation session says:
- The app is **Live**.
- **All four Instagram Login permissions are Pending App Review**:
  `instagram_business_basic`, `instagram_business_manage_comments`,
  `instagram_business_manage_messages`, `instagram_business_content_publish`.
- The dashboard usage counters were 122, 30, 7 and 7. These are historical counters,
  not evidence that the public comment-launch path works.
- The owner's real test comment did not produce a demonstrated launch. Advanced Access is
  the suspected remaining blocker; webhook delivery and access level need checking separately.

The owner's next steps:
1. Check the App Review page for an approval or reviewer request. Keep the review focused on the
   four permissions above. The current app uses Instagram Login; do not add unrelated `pages_*`,
   ads, insights, Human Agent, Business Asset User Profile Access or legacy Facebook Login
   permissions to this review.
2. In Meta's webhook configuration, check that `comments` is subscribed. Use Meta's **Test**
   beside `comments`, then check /admin's **Comment events received from Meta** counter.
   A successful synthetic Test proves delivery, not that public @mentions or launches work.
3. After approval, test one public-account @mention and inspect /admin's event counter,
   latest payload and request result. Only if a delivered request says the post cannot be read,
   follow `docs/LAUNCH.md` step 12f; then retry that request.
4. The fee payer was last observed at roughly **0.0693 SOL on 10 Oct**. This balance is not current.
   Comment launches pause below the configured 0.1 SOL floor; the bot has a separate 0.5 SOL floor.
   Any funding or live launch test is an owner action.
5. App Review was reported submitted. The **almost-live** carousel version (`slide-6.jpg` plus
   the caption in `docs/OWNER-DRAFTS.md`) is ready for owner review. Hold back the **live** version
   until a real public comment has launched a coin successfully.
6. Tech Provider access verification was still unconfirmed, due **30 Nov 2026**. Keep its
   separate checklist in `docs/OWNER-DRAFTS.md`; it is not the explanation for the missing comment.
7. Other existing items remain: Phantom ticket 414019, key backups, profile/app images,
   tags on older posts and a real claim test.

Scouting from Render was previously rate-limited. The current positions of the Scouting and
Auto-launch switches were not rechecked; do not infer they changed.

Likely next technical work: diagnose the first delivered real event using /admin and the
`mention:` read-result logs. The fallback's real Meta tokens and Business Discovery paths
still need live evidence. Do not report comment launches as live based only on app mode,
permission usage counters, the synthetic Test or a merged PR.

## The product, in one paragraph

InstaPaid (https://instapaid.fun, Instagram **@instapaid.official**) lets fans launch pump.fun meme coins for
Instagram creators. Only the creator can claim the coin's creator fees. Ways in: comment
`@instapaid.official make a token for this creator` under a public post (the server launches, pays, replies
and posts the coin on @instapaid.official tagging the creator), launch on the website with your own wallet
(Phantom/Solflare), and now the **launcher bot** (below). Operated by **Brylliant Labs Inc.** (Philippines,
Business Verified with Meta). Repo: `gtjvv976mb-netizen/InstaPaid`; the server is `server/` (Node, Express,
SQLite via better-sqlite3), deployed on **Render**, which auto-deploys `main`.

## What is merged and live

`main` includes #35 (merged 10 Oct; see "Start here"). The interrupted continuation's checkout was reported clean before this docs update. Work happens on the branch the session is
given (1 Oct and before: `claude/epic-curie-4on4v4`; 1–9 Oct: `claude/quirky-pasteur-w4ajnq`; 10 Oct:
`claude/blissful-goldberg-yzyemt`); each change is a
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
| #35 (merged 10 Oct) | On `claude/blissful-goldberg-yzyemt`: comment events kept for /admin, Try again, one reply when the post is unreadable, a fourth read (`GET /<comment-id>`); the bot's watchlist (Business Discovery reads); the Facebook Login fallback's server side (`FB_APP_SECRET`, the Page subscription, the poster stays on Instagram Login). |

Earlier (before #19): "pump" vanity mint addresses (`mintpool.js`, `mint-grinder.js`), coin pictures served at
`/coins/<mint>.webp` (`coinimages.js`), the `catchUp()` of coins that went live while posting was off,
`/terms`, the new mark (not Instagram's colours), a test that comment launches work under videos and Reels (#14).

## Comment launches: earlier diagnosis (6 Oct; Start here supersedes the app-mode state)

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
- **The watchlist (added 10 Oct):** /admin → Launcher bot → **Watchlist**: the owner pastes creators, one
  per line, a username and optionally a link to one of their posts (`bot_watch` table). Auto-launch takes them
  before the shortlist, oldest first, no score needed, within the same caps and SOL floor. The profile is
  read through Meta's **Business Discovery** API first (Business and Creator accounts; tried with the
  Instagram token on graph.instagram.com, which is not documented and dropped once Meta refuses the field,
  then with Facebook Login, which is documented), then instagram.com's page (blocked from Render). Named and
  pictured from the linked post if it is among the 12 read, else their most engaged post. Nothing readable:
  only a creator with a linked post launches (default picture, the link as the coin's website); a bare
  username waits (could be a typo). instagram.com saying the account does not exist: never launched. Two
  tries per creator; pasting again resets them. Watchlist coins' description leaves out "trending".
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
CHAIN_TEST=0 npm test        # 206 tests: 201 pass, 5 mainnet tests skipped
```
- In the 10 Oct sandbox one test failed on unchanged `main` too: `the card is the same on a host with no fonts
  installed` (one label 1 pixel off, a font-rendering difference of that machine); it passed in earlier sessions.
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
