# InstaPaid

**https://instapaid.fun** · Instagram: **@instapaid.official**

Launch a pump.fun coin for any Instagram account, from a browser extension or by commenting
`@instapaid.official make a token` under a post. The coin's creator fees build up for that account,
and **only the verified owner of that account can claim them**, like
[telepaid](https://telepaid.app/) does for Telegram. @instapaid.official then posts new coins on its
own feed and @mentions the creator, so they find out they have fees to claim.

```
extension/    Chrome (MV3) extension: "Launch a coin" on instagram.com profiles, with the account's totals
server/       Node + Express + SQLite: launch, comment launches, the auto-poster, Instagram DM
              verification, claims, and the web pages
render.yaml   Render Blueprint: one web service with a disk (docs/LAUNCH.md is the go-live checklist)
```

## How it works

**Launch.** On a profile, the extension opens `/launch?u=<username>&pic=<profile picture>`. The
launcher names the coin and signs with their own wallet (Phantom, Solflare). They pay pump.fun's launch
cost and any first buy (its own transaction, which the wallet signs and sends once the coin is live; both
use the launch lookup table, `npm run lookup-table`). The server builds the launch with `@pump-fun/pump-sdk` `create_v2`, and
sets the coin's **creator** to a vault wallet belonging to that Instagram username. The launcher is
never the creator. The server signs as the new mint before handing the transaction over. If anyone
edits the transaction (to make themselves creator, say), the mint's signature no longer matches and
Solana rejects it. After it lands, `/api/launch/confirm` reads the bonding curve on-chain and lists the
coin only if its creator really is the vault.

**Or by comment.** Anyone comments `@instapaid.official make a token ...` under a public post. Meta
sends a `comments` webhook (Instagram Login; `mentions` on the legacy Facebook Login path). The server
reads the comment and the post, and launches a coin for the
**post's owner**, paying the launch from its own wallet. The coin is made from the post:

| | Comes from |
|---|---|
| Name and ticker | Claude looks at the post's photo and caption (`src/lore.js`). Without Claude: the caption's first words (no hashtags, @mentions, links or emoji; at most 32 characters, cut at a word), else the username; the ticker is the name's letters and digits (2–10). |
| Picture | The post's photo (a video's or reel's thumbnail); the default coin for a carousel Meta sends no picture for. |
| Website (pump.fun metadata) | The post's link, `https://www.instagram.com/p/...` (only instagram.com links are used; otherwise `instapaid.fun/u/<creator>`). |
| Description | Empty, unless the commenter wrote lore after the command, e.g. `@instapaid.official make a token for this creator: king of sunsets`. The lore is NFKC-normalised and loses the "for this creator" part, every `@`, links in any spelling (http(s), "hxxp", www., bare domains, "site dot com", `evil[.]com`, full-width dots) and wallet addresses; it is capped at 400 characters, and used **only if Claude passes it**: not hateful, sexual, harassing, defamatory or impersonating, no promise of price or profit, no request to send money or crypto, no wallet address, link or contact handle, and no telling readers to do anything (DM, join, claim, airdrop…). Without Claude, lore is dropped: no unmoderated words go on-chain. The caption and lore reach Claude as one JSON object (with `<` and `>` escaped), so a comment cannot forge the prompt's structure. |

The bot then replies under the comment, so the fan knows it worked (the lore is not in it):

```
$GEO is live for @nat.geo
Coin: pump.fun/coin/<mint>
@nat.geo can claim the creator fees: instapaid.fun/u/nat.geo
Fan-made, not by @nat.geo.
```

The rules:
- A creator who already has a coin gets no second one by comment; later requests get a reply pointing
  to that coin.
- Each comment is handled once, even when Meta retries the webhook.
- Comment launches run one at a time.
- **A launch is recorded before it is sent.** Its row (status `prepared`, with the signature and the
  blockhash's last valid height) already counts as the creator's coin and against the day's budget.
  If the RPC refuses the send, the row goes and the fan may try again. If the confirmation is lost (a
  timeout, an expired wait), the server asks the chain before replying: landed → live; failed or
  expired without landing → the row goes and the fan is told to try again; still unknown → the fan
  is told it is waiting for Solana, and every two minutes the server looks again (then replies under
  the same comment and queues the post). No path launches twice for one creator.
- `MAX_SERVER_LAUNCHES_PER_DAY` and `MIN_FEE_PAYER_SOL` cap what the server spends. When a cap is
  hit, the bot replies that launches are paused.
- A creator who opted out (below) gets no coin; the bot answers once for that creator (not once per
  post, so nobody can make it notify them again and again), without an @: "creator has asked not to
  have coins made for them."
- Website and extension launches are unchanged: the launcher names the coin, the description is the
  fixed "whose fees these are" header plus the launcher's optional text, the website is
  `instapaid.fun/u/<username>`.

Meta limits what the bot can see:
- The comment must **@mention** the bot. The plain word "instapaid" sends nothing.
- Posts on **private** accounts and Stories send nothing.
- Everything runs on the *Instagram API with Instagram Login* (the bot is a Business or Creator
  account; no Facebook Page). Meta lets one app use Instagram Login or Facebook Login, not both. The
  Facebook Login path still works when `IG_USER_ID` and `IG_FB_ACCESS_TOKEN` are both set.
- With Instagram Login, @mentions arrive in the `comments` field, with nothing that tells them apart
  from comments on the bot's own posts: a comment counts when it names the bot and has the command,
  and the bot's own posts and its own replies never launch anything.
- Links in Instagram comments aren't clickable, so the reply spells them out.
- Reading someone else's post (for its owner's `username`) is not documented for Instagram Login. The
  server tries `mentioned_comment`, then `mentioned_media`, then `/<media id>` on graph.instagram.com
  (then Facebook Login, if set up), logging one line per try. If none gives the owner, nothing is
  launched and nothing is replied. **Check this first with a real comment.**

**The auto-poster.** Coins that go live (by comment or on the website) are posted on
@instapaid.official's feed, when `AUTO_POST=1` (`src/poster.js`, `src/card.js`). Not every coin:

- **At most one post per creator** in `POST_CREATOR_GAP_DAYS` (30 days; 0 = no limit), and none while
  another of their coins is waiting, so nobody can make our account @mention the same person again
  and again. The coin that is not posted gets a `skipped` job saying why.
- **Comment launches go first.** The queue posts comment launches before website launches, so a burst
  of website launches cannot push them back (they would otherwise reach `POST_MAX_AGE_H` and be skipped).
- **Website and extension launches are checked by Claude first** (`reviewCoin` in `src/lore.js`),
  because whoever launched chose the name, the ticker and the picture. A name or ticker that is
  hateful, sexual, mocking, defamatory, impersonating, scammy (giveaway, airdrop, "send"), or carries
  a link, wallet or contact → no post. A picture with nudity, violence, hateful symbols, calls to
  send or claim, QR codes, wallet addresses or someone else's logo → the card shows the default coin
  instead. **Without `ANTHROPIC_API_KEY`, website launches are not posted.** Comment launches need no
  second check: Claude names them from the creator's own post, and the picture is the creator's own.
- Uploaded pictures must be the PNG, JPEG, WebP or GIF they say they are (checked by their first
  bytes); an SVG or anything else is refused at `/api/launch/prepare`, and the card never draws one.

The picture is a 1080×1350 JPEG card: the coin's picture on the brand gradient, and on one dark panel
`$TICKER`, the name, "for @creator" and "Claim at instapaid.fun/u/<creator>" (long names are set
smaller, then cut with "…"; every line measures over 10:1 against the panel). The fonts are bundled in
`server/assets/fonts` (Inter, and Noto Sans for Japanese, Chinese, Korean, Arabic, Hebrew, Thai and
Devanagari names), so the card is the same on a host with no fonts at all; a name with a letter none
of them has is left off the card rather than drawn as boxes, and stacked combining marks are capped
and clipped so no line runs into the next. The caption:

```
$GEO is live for @nat.geo 🚀

@nat.geo — this coin's creator fees are yours. Only you can claim them: instapaid.fun/u/nat.geo

"<the lore Claude passed, if any>"

Original post: https://www.instagram.com/p/...
Coin: pump.fun/coin/<mint>

Fan-made, not by @nat.geo. Not financial advice.
#memecoin #solana #pumpfun
```

Nothing anyone typed goes in except the ticker, the handle, the post's link and the lore Claude
passed (its @s and #s removed); on the card, a website launch's name and picture only after Claude's
check. It stays within Instagram's 2,200 characters, 20 @mentions and 30 hashtags. The creator is
@mentioned in the caption; the post adds no photo tag.

How it posts: the Instagram Content Publishing API through the same Facebook-Login token as comment
launches (permission `instagram_content_publish`). `POST /{ig-user-id}/media` with
`image_url=https://instapaid.fun/posts/<mint>.jpg` makes a container, the worker waits for its
`status_code` to be `FINISHED`, then `POST /{ig-user-id}/media_publish`, then reads the post's
permalink. Before each post it reads `content_publishing_limit` and waits if Instagram's quota (100
posts a day) is used up.

- A worker inside the server ticks every minute (and a few seconds after a coin goes live), one post
  per tick. Pacing: `POST_MAX_PER_DAY` (25 in any 24 hours), `POST_MIN_GAP_MIN` (20 minutes apart),
  `POST_MAX_AGE_H` (a coin not posted within 24 hours is skipped rather than posted stale),
  `POST_CREATOR_GAP_DAYS` (one post per creator in 30 days), `POST_WEB_LAUNCHES` (0 = only comment
  launches are posted).
- A failed post is retried after 5 minutes, 30 minutes and 2 hours, then marked failed. Three failures
  in a row pause all posting for an hour (logged).
- **At most one post per coin, also across restarts.** The queue (`post_job`) is keyed by the coin, and
  the container id is saved before `media_publish`. A post interrupted by a restart, or whose answer
  was lost, is resumed by asking Instagram for that container's status: `PUBLISHED` means it went out
  (the post is found on the feed and recorded), `FINISHED` means it did not (it is published now).
- Cards live in `POSTS_DIR` (default: `posts/` beside the database, git-ignored) and are served
  publicly at `/posts/<mint>.jpg` (only mint-shaped names). Website launches keep the uploaded picture
  (shrunk, as a JPEG, under `POSTS_DIR/src/`) until `/api/launch/confirm` has it checked and the card
  drawn; kept pictures of launches never confirmed are deleted after 48 hours.
- `GRAPH_BASE_URL` (default `https://graph.facebook.com`) points comment reads, replies and the poster
  at a stand-in Graph API, for a staging server; it must be https, or http on localhost.
- **Instagram's API cannot delete posts.** To take one down, delete it in the Instagram app.

**Opting out.** A creator who asks not to have coins made for them:

```bash
npm run block -- <username> "asked by DM on 27 Sep"   # no new coins by comment or website, no posts
npm run block -- list
npm run unblock -- <username>
```

Blocking skips their coins still waiting to be posted and lists the ones already posted (delete
those by hand in the Instagram app). Coins already on-chain stay there; their fees still go to the
creator's vault and they can still claim them.

**One vault per account.** pump.fun keeps creator fees per creator, so every coin launched for
`@alice` pays into one creator vault. That covers both the bonding curve and PumpSwap after the coin
graduates. The vault's key is created on the server and stored encrypted (AES-256-GCM under
`VAULT_MASTER_KEY`, bound to the username).

pump.fun's own "social fee" accounts only cover X and GitHub, and pump.fun holds their claim key, so
Instagram needs its own vault.

**Claim.** The owner opens `/claim`, gets a one-time code (`IP-XXXXXXXX`, valid 15 minutes) and DMs it
to your app's Instagram account. Meta's webhook (signature checked with `IG_APP_SECRET`) reports the
sender's Instagram-scoped id (IGSID). The server reads the sender's username with the User Profile API.
The page then moves on by itself, and the owner enters any Solana wallet. The server collects the
creator fees into the vault and sends the whole balance on, minus `PLATFORM_FEE_BPS` if you set one.
A server hot wallet (`FEE_PAYER_SECRET`) pays the network fees. Below about 0.001 SOL, an empty vault
can't be opened yet (Solana's rent minimum), and the claim says to come back later.

**Renames and recycled handles.** The first claim binds the vault to the claimant's IGSID for good:

| Situation | Who can claim `@alice`'s vault |
|---|---|
| Never claimed | Whoever holds the username `alice` when they verify (this binds it) |
| Claimed, then alice renames to `alice.new` | Still her (matched by IGSID). Coins launched later for `@alice` keep going to her vault. |
| Someone else then takes the `alice` handle | Nobody new. The vault is bound to the original IGSID. |

The one gap: if a handle changes owner *before* its first claim, the new holder can claim it. The
account page shows whether a vault has been claimed.

## Run it

```bash
cd server
npm install
cp .env.example .env     # then fill it in (see below)
npm test                 # 99 tests; the chain tests read mainnet (never send) and skip offline
npm start                # http://localhost:8787 (GET /healthz answers {"ok":true})
```

Then load the extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/`. It
talks to **https://instapaid.fun** by default (`DEFAULT_SERVER` in `extension/settings.js`). To use a
local server, set its address in the extension's options.

### Instagram setup (one-time)

`docs/LAUNCH.md` is the full go-live checklist (hosting, domain, wallet, Meta app, first test). In short:

1. The app's Instagram account is **@instapaid.official** (`IG_BOT_USERNAME`): people DM codes to it
   and @mention it in comments. Switch it to a **professional** account.
2. Create a Meta app with the **Instagram API with Instagram Login** product. Add that account, and
   generate a token with `instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments` and `instagram_business_content_publish`. That is
   `IG_ACCESS_TOKEN` (DMs, comment launches and the auto-poster); the app secret is `IG_APP_SECRET`.
   The bot's Instagram id is read from the token at start. The token lasts 60 days; the server
   renews it (`src/igtoken.js`, kept sealed in the database): a pasted token once it has been there 24
   hours, then every 7 days. It warns in the logs daily from 10 days before the end if renewing fails,
   and at once, then daily, if Meta refuses the token itself (expired or revoked).
3. Set the webhook callback to `https://<your host>/webhooks/instagram`, with verify token
   `IG_WEBHOOK_VERIFY_TOKEN`, and subscribe to `messages` and `comments` (the server also subscribes
   the account at start). If webhooks are signed with the Meta app's own secret, set it as
   `META_APP_SECRET` too. `COMMENT_LAUNCHES=0` switches comment launches off.
4. (Legacy, optional) The Instagram API with Facebook Login still works when `IG_USER_ID` and
   `IG_FB_ACCESS_TOKEN` are both set; it needs a Facebook Page linked to the account.
5. Using messaging and comments with the public (not only the app's testers) needs Meta's **App
   Review** and Advanced Access for `instagram_business_manage_messages`,
   `instagram_business_manage_comments` and `instagram_business_content_publish`, Business
   Verification, and the app in Live mode.

People who claim can use personal accounts. Only the app's own account must be professional. An IGSID
is scoped to the app's account, so keep that account: a new one would see new IGSIDs, and vaults that
were already claimed could not be matched.

### Secrets

- `VAULT_MASTER_KEY`, `SESSION_SECRET`: `openssl rand -hex 32` each. **Losing `VAULT_MASTER_KEY`
  loses every unclaimed fee.** Back it up apart from the database.
- `FEE_PAYER_SECRET`: a fresh wallet. It pays network fees for claims and pays for comment launches
  (about 0.02 SOL each), so keep `MIN_FEE_PAYER_SOL` plus a day of launches in it.
- The server refuses to start with any of these missing or malformed.

### Hosting

`render.yaml` is a Render Blueprint: one Node web service (`rootDir: server`, `npm ci`, `npm start`)
with a 1 GB disk at `/var/data` for the database (`DB_PATH`) and the poster's cards (`POSTS_DIR`), and
`/healthz` as its health check. Keep it at **one instance**: SQLite is a file on that disk, and the
auto-poster runs inside the web process. Secrets are entered in Render's dashboard, never in the
file. `docs/LAUNCH.md` is the owner's checklist, from the Render account to the first real comment.

## Verified

- Unit and flow tests: webhook signatures, single-use and expiring codes, claim tokens that can't be
  forged or used after the claim window, one vault per account, rename and recycled-handle rules,
  images fetched only from Instagram's CDNs, and the disclaimer on every coin.
- On mainnet (read-only): the launch transaction, with and without a first buy, **passes simulation in
  the pump.fun program** (102k and 188k compute units) with the vault as creator. Collecting a real
  creator's fees with a separate fee payer also passes simulation, and the creator's balance rose by
  exactly the fees waiting. Collecting needs no signature from the creator; moving the money out of the
  vault does, and only the server holds that key.
- Comment launches (mocked Instagram and chain):
  - the post owner's vault is the creator;
  - the name and ticker come from the post (Claude gets the post's picture, not the default image);
    the website is the post's link, or the creator's page when the link is not instagram.com;
  - the description is the fan's lore only when Claude passed it, empty otherwise; many comment
    shapes are tested for the lore (links in every spelling, wallet addresses, @s, "for this
    creator", full-width text, 400 characters), and a lore that forges the prompt stays one JSON value;
  - the reply is exactly the four lines above, without the lore;
  - a creator who opted out gets one polite reply (per creator, without an @) and no coin, and the
    website refuses too;
  - a webhook retry, a second fan, or two comments at once make one coin;
  - forged webhooks, comments that don't ask, posts with no known owner, and our own posts are ignored;
  - the daily cap and a low fee payer pause launches;
  - a failed launch replies once; a launch whose confirmation is lost is recorded before it is sent,
    and is settled from the chain (landed → live, expired → dropped, unknown → looked at again) without
    ever launching twice or telling the fan to retry too early;
  - carousel posts use the default image.
- The auto-poster, against a fake Graph API: the call sequence (limit → container → status →
  publish → permalink), a used-up quota, the gap and the daily cap, stale coins skipped, retries at 5
  min / 30 min / 2 h, the circuit breaker (and that it survives a restart), a restart in the middle of
  a post, a publish whose answer was lost (found, not posted twice), a rejected container, opted-out
  creators, one post per creator in 30 days, comment launches before website launches (26 website
  coins for one handle cannot delay a comment coin), website launches posted only after Claude's
  check (a failed picture becomes the default coin), SVGs sent as PNGs never kept, and nothing at all
  with `AUTO_POST` off.
- The card, measured on the rendered JPEG: 1080×1350; a 10-letter ticker, a 32-character name and a
  30-character handle stay on one line inside the panel; every line at least 10:1 against the panel's
  own pixels over white, yellow and black pictures; Japanese, Chinese, Korean, Arabic, Hebrew, Thai
  and Hindi names are drawn, and drawn the same in a process with no system fonts at all; a name no
  bundled font covers is left off; stacked combining marks never push a line into the next.
- `/posts/` serves only `<mint>.jpg` (encoded `../`, other extensions and other names are 404);
  `/healthz` is 200 with the database and 503 without; an existing database upgrades in place.
- The server-paid launch transaction is built on mainnet data and fully signed. It was not sent.
- Claude's output is cleaned (length, ticker characters, emoji) before it goes on-chain. The live
  naming and review calls have not been run here, because this machine has no Claude API key.
- Browser: the launch and claim flows, at 1280px and 390px, with a stand-in wallet. The extension on a
  mock profile page adds the bar, shows the account's totals, opens the launch page with the profile
  picture, and removes itself when you navigate away.

Not yet run end to end with real SOL, a real pump.fun metadata upload, a live Instagram webhook, or a
real Instagram post. Do the first test in `docs/LAUNCH.md` (one comment, the reply, the post, one
claim) before you announce it.

## Things to decide before launch

- **Comment launches spend your SOL.** Each costs about 0.02 SOL from the fee payer. Anyone can
  trigger one for any creator with a public post, up to the daily cap. `PLATFORM_FEE_BPS` (e.g. 2000,
  TelePaid's 20%) is how that cost comes back.
- **Website launches on your feed.** A website or extension launch's name, ticker and picture are
  whatever the launcher chose. The poster posts them only after Claude's check (and not at all
  without `ANTHROPIC_API_KEY`), at most one post per creator a month. If you would rather your
  account never shows a stranger's choices, set `POST_WEB_LAUNCHES=0`.
- **This is custodial.** Until an account claims, its fees sit in a wallet whose key your server holds.
  Keep the host locked down, and consider a KMS/HSM for `VAULT_MASTER_KEY`.
- **Launching in someone's name.** Website coins' descriptions say whose fees these are and that a fan
  launched it; comment coins, by the owner's choice, carry only the fan's lore (or nothing) and link
  to the post. The reply, the post and the account page all say "fan-made, not by @creator". Still, a
  coin named after a real person can mislead buyers, and it may conflict with Instagram's and
  pump.fun's terms and with securities or consumer law where you operate. Get legal advice.
  `npm run block` is the takedown path for accounts that object.
- **Posting about people.** The auto-poster tags every creator a coin is launched for, from the
  brand's own account. Instagram may treat many unsolicited tags as spam; start with the defaults
  (25 a day, 20 minutes apart) and watch the account. Website launches' names and tickers are typed
  by the launcher and go on the card without a model check.
- **Metadata** goes to pump.fun's IPFS endpoint (`IPFS_UPLOAD_URL`), which is unofficial and can change.
- **The SDK's ESM build doesn't import** (`@coral-xyz/anchor` is CommonJS), so `src/pump.js` loads its
  CommonJS build with `createRequire`.
- **Rate limits** are in-memory (20 launches and 20 verifications an hour per IP). Use a shared store
  if you run more than one instance, and set `TRUST_PROXY=1` behind a proxy.
