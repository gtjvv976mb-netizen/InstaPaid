# Going live: the checklist

Everything you have to do to put InstaPaid on **https://instapaid.fun**, in order. Tick each box.
Nothing here needs code. Where a step says "copy X into Render", it means: Render dashboard → the
`instapaid` service → **Environment** → the key → paste → **Save** (Render redeploys by itself).

Allow a day for the technical part and **days to weeks for Meta's App Review** (step 14). You can test
everything with your own accounts before the review is done.

---

## Part 1 — Accounts you need

1. [ ] **A Render account** (render.com). You will need a paid plan for the service (Starter, about
   $7 a month) because the database lives on a disk, and disks need a paid instance. Add a card.
2. [ ] **Access to the domain instapaid.fun** at the company you bought it from (the registrar), so
   you can change its DNS records.
3. [ ] **A paid Solana RPC.** The free public one (`api.mainnet-beta.solana.com`) blocks you under
   load. Sign up at Helius, QuickNode or Triton, create a **mainnet** endpoint, and keep its HTTPS URL
   (it looks like `https://mainnet.helius-rpc.com/?api-key=...`). That is `RPC_URL`.
4. [ ] **An Anthropic API key** (console.anthropic.com → API keys). Claude names comment coins from the
   post and checks fans' lore. Without it coins are still made, named from the caption, with no lore.
   That is `ANTHROPIC_API_KEY`.
5. [ ] **The Instagram account @instapaid.official**, set to **Professional** (Instagram app →
   Settings → Account type and tools → Switch to professional account → **Creator** or **Business**;
   @instapaid.official is a Creator account, and Instagram Login works with either). Keep it
   **public**. Give it a profile picture and a bio that says what it is ("Fan-made coins for
   creators. Creators: claim your fees at instapaid.fun").
6. [ ] **No Facebook Page is needed.** Everything (claim codes by DM, comment launches, the
   auto-poster) runs on *Instagram Login*, straight on the Instagram account. (An older setup used a
   Facebook Page and *Facebook Login*; Meta lets one app use only one of the two, and it is no longer
   needed. Skip this step.)
7. [ ] **A Meta developer account** (developers.facebook.com). Also a **Meta Business portfolio**
   (business.facebook.com) for your company: Meta's **Business Verification** of it is needed before
   comment launches can work for the public (step 14).

## Part 2 — The secrets

Make these on your own computer (Mac: open **Terminal**). Keep a copy of each in your password
manager. **Never** put them in the code, in a chat or in an email.

8. [ ] Make and save each of these:
   - `VAULT_MASTER_KEY` — run `openssl rand -hex 32`. It encrypts every creator's vault key.
     **If you lose it, every unclaimed fee is lost for good.** Save it in two places (password manager
     and a printed copy in a safe place). Never change it.
   - `SESSION_SECRET` — run `openssl rand -hex 32` again (a different value).
   - `IG_WEBHOOK_VERIFY_TOKEN` — run `openssl rand -hex 16`. Any random text; you will paste it into
     Meta's webhook settings too.
   - `FEE_PAYER_SECRET` — **a new Solana wallet only for the server** (never your personal one).
     In the `server` folder run:
     `node -e "const {Keypair}=require('@solana/web3.js');const k=Keypair.generate();console.log('address', k.publicKey.toBase58());console.log('secret', JSON.stringify(Array.from(k.secretKey)))"`
     The `secret` line (the whole `[...]`) is `FEE_PAYER_SECRET`; the `address` is where you send SOL.
   - **Fund the server wallet**: send it about **0.5 SOL** from your own wallet. Each comment launch
     costs it about 0.02 SOL and each claim a tiny network fee. Comment launches pause by themselves
     below `MIN_FEE_PAYER_SOL` (0.1). Check its balance weekly (solscan.io/account/<address>).

## Part 3 — The server on Render

9. [ ] **Deploy.**
   a. Render → **New** → **Blueprint** → connect GitHub → pick the InstaPaid repository → Render reads
      `render.yaml` and shows one web service, `instapaid`, with a 1 GB disk. Click **Apply**.
   b. Render asks for every value marked `sync: false`. Fill in what you have now: `RPC_URL`,
      `FEE_PAYER_SECRET`, `VAULT_MASTER_KEY`, `SESSION_SECRET`, `IG_WEBHOOK_VERIFY_TOKEN`,
      `ANTHROPIC_API_KEY`. The Instagram ones (`IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `META_APP_SECRET`)
      come in Part 4. Leave `IG_USER_ID` and `IG_FB_ACCESS_TOKEN` **empty**: they are only for the
      old Facebook Login route, and the server reads the bot's id from `IG_ACCESS_TOKEN`. The server will not start until
      `IG_ACCESS_TOKEN`, `IG_APP_SECRET` and `IG_WEBHOOK_VERIFY_TOKEN` are set, so put a placeholder
      like `pending` in the first two for now, and replace them in step 11.
   c. Leave `AUTO_POST` at `0` for now (step 15 turns it on).
   d. When the deploy is green, open `https://instapaid.onrender.com/healthz` (Render shows the exact
      `.onrender.com` address at the top of the service). It must say `{"ok":true}`.
   e. Render's **Logs** tab should show `instapaid on :10000 (https://instapaid.fun)` and
      `auto-poster off: AUTO_POST is not 1`.

10. [ ] **Custom domain.** Render → the service → **Settings** → **Custom Domains** → add
    `instapaid.fun`, then add `www.instapaid.fun`. Render shows the DNS records to create. At your
    registrar's DNS page:
    - for `instapaid.fun` (the "apex", written `@`): the **A** record Render shows (or an ALIAS /
      ANAME record to your `.onrender.com` address if your registrar offers it);
    - for `www`: a **CNAME** to your `.onrender.com` address;
    - delete any old **AAAA** records and "parking" records for `@` and `www`.
    Wait until Render shows both domains as **Verified** with a certificate (minutes to a few hours).
    Then `https://instapaid.fun/healthz` must say `{"ok":true}`.
    Also: Render → the service → **Disks** — daily snapshots are on by default; keep them.

## Part 4 — The Meta app (Instagram)

The server talks to Instagram one way: the **Instagram API with Instagram Login**, with one token for
@instapaid.official. It carries the claim codes people DM to the bot, the comments that mention the
bot (read, launched, replied to), and the posts on the bot's own feed. Meta's App Review page says an
app "can either use Facebook Login or Instagram Login but not both", so there is no Facebook Login and
no Facebook Page. (The server still has the old Facebook Login route, used only when `IG_USER_ID` and
`IG_FB_ACCESS_TOKEN` are both set. Leave them empty.)

11. [ ] **Create the app and connect Instagram Login (claim codes by DM).**
    a. developers.facebook.com → **My Apps** → **Create app** → type/use case **Business** (or
       "Manage messaging & content on Instagram"). Name it InstaPaid. Attach your Business portfolio.
    b. Add the product **Instagram** → **API setup with Instagram login**. Under **Generate access
       tokens**, add @instapaid.official and generate a token. Grant `instagram_business_basic` and
       `instagram_business_manage_messages`. Copy the token into Render as **`IG_ACCESS_TOKEN`**.
       This kind of token lasts **60 days**: put a reminder in your calendar for day 50 to generate a
       new one here and paste it into Render.
    c. On the same page, copy the **Instagram app secret** into Render as **`IG_APP_SECRET`**. Then
       App settings → **Basic** → **App secret** (the Meta app's own) → **Show** → copy it into Render
       as **`META_APP_SECRET`**. (Meta signs some webhooks with one and some with the other; the server
       accepts either.)
    d. Under **Configure webhooks**: Callback URL `https://instapaid.fun/webhooks/instagram`, Verify
       token = your `IG_WEBHOOK_VERIFY_TOKEN` → **Verify and save** (it must succeed; if it fails, check
       step 10 and that the service is running). Subscribe the field **`messages`**.
       Turn on the account's webhook subscription with the toggle next to @instapaid.official.

12. [ ] **Comment launches and the auto-poster, on Instagram Login.**
    a. App → **Use cases** → the Instagram use case ("Manage messaging & content on Instagram") →
       **Customize** → **Permissions and features**: add **`instagram_business_manage_comments`**
       (reading the comments that mention the bot, replying under them) and
       **`instagram_business_content_publish`** (posting on the bot's feed). `instagram_business_basic`
       and `instagram_business_manage_messages` are there from step 11.
    b. **Generate a new token.** Instagram → **API setup with Instagram login** → **Generate access
       tokens** → @instapaid.official → **Generate token**, and approve all four permissions in the
       window that opens (a token made before step a does not carry the new two). Copy it into Render
       as **`IG_ACCESS_TOKEN`**, replacing the one from step 11b. The 60-day reminder from step 11b now
       counts from today.
    c. **Subscribe `comments`.** Same page → **Configure webhooks** → the webhook fields → subscribe
       **`comments`** next to `messages`. (With Instagram Login there is no separate `mentions` field:
       an @mention of the bot in a comment under someone else's post arrives as a `comments` event.)
    d. **Check the start-up lines.** After Render redeploys, Logs → the lines at start:
       ```
       instagram: @instapaid.official id 1784…
       comment launches on, via Instagram Login
       instagram: webhook subscribed (messages,comments): {"success":true}
       ```
       The server reads the bot's id from the token and subscribes the account to `messages` and
       `comments` itself, at every start. `could not read the bot account` = the token is wrong or
       expired (step b again). `webhook not subscribed … (#…)` = the line says what Meta refused: most
       often a token without `instagram_business_manage_comments`.
    e. Leave **`IG_USER_ID`** and **`IG_FB_ACCESS_TOKEN`** empty, and **`COMMENT_LAUNCHES`** at `1`
       (`0` switches comment launches off without touching the token; DMs and the poster go on).

13. [ ] **Testers (before App Review).** While the app is in Development mode, Instagram only works for
    people with a role on the app. App → **App roles** → **Roles** → add the people who will test
    (as Testers), and in the Instagram product add their Instagram accounts as **Instagram testers**;
    each tester accepts the invite in Instagram (Settings → Apps and websites → Tester invites).
    Use **your own test accounts** as "creators" for testing — never a real person's account.

14. [ ] **App Review (to open it to everyone).** App → **App Review** → **Permissions and features**:
    request **Advanced Access** for `instagram_business_basic`, `instagram_business_manage_messages`,
    `instagram_business_manage_comments` and `instagram_business_content_publish`. For each one Meta
    wants a sentence on how it is used and a screen recording. Say plainly:
    - messages: "Creators DM a one-time code to @instapaid.official to prove they own their account
      before claiming their coin's fees."
    - comments: "When someone comments '@instapaid.official make a token' under a public post, we read
      that comment and the post it is on, and reply to it with the coin's link."
    - content publish: "@instapaid.official posts an announcement of new coins on its own feed and
      @mentions the creator in the caption so they can claim."
    Record the flows from Part 5 (steps 16–21) with a tester.

    **Plainly: until Advanced Access for `instagram_business_manage_comments` is granted, comment
    launches only work for accounts with a role on the app** (step 13). A comment from anyone else
    sends no webhook, so nothing happens and nothing is logged. Advanced Access needs **App Review
    and Business Verification** of your Business portfolio (company documents; business.facebook.com →
    Settings → Security Center → Start verification). When both are approved, switch the app to
    **Live** (top of the app dashboard): webhooks for the public arrive only in Live mode.

## Part 5 — The first real test

Do this with **your own two test accounts**: one as the fan who comments, one public professional
account as the "creator" (with one photo post). It spends about 0.02 SOL.

15. [ ] **Turn the poster on for the test.** First check the card's fonts on Render itself: Render →
    the service → **Shell** (`cd server` if needed) → `npm run sample-card`. Open the three addresses it
    prints: a Japanese, an Arabic and a Latin name, each drawn in real letters (never rows of little
    boxes). Then Render → Environment → `AUTO_POST` = `1` → Save. After the redeploy, the Logs say
    `auto-poster on: at most 25 a day, 20 min apart, via Instagram Login (graph.instagram.com)`. Make sure `ANTHROPIC_API_KEY` is set: without it,
    coins launched on the website are not posted (comment launches still are).
16. [ ] **One comment.** From the fan account, under the creator's photo, comment:
    `@instapaid.official make a token for this creator: first light over the pines`
    (it must @mention the bot; typing "instapaid" without the @ sends nothing).
17. [ ] **Check the reply** (within a minute or two) under that comment. It must read, with the real
    ticker and coin address:
    ```
    $TICKER is live for @yourcreator
    Coin: pump.fun/coin/<address>
    @yourcreator can claim the creator fees: instapaid.fun/u/yourcreator
    Fan-made, not by @yourcreator.
    ```
    No reply? Render → Logs. Every webhook logs its shape first (`webhook: entry 1/1 entry={…}
    field=comments value={from,id,media,text} …`: keys and lengths only, never the words). Then the
    server reads the post, trying three ways, one line each:
    ```
    mention: read post via mentioned_comment → 400 (#10) Application does not have permission …
    mention: read post via mentioned_media → 400 (#100) …
    mention: read post via media → 200, owner @yourcreator
    ```
    The first `→ 200, owner @…` wins; failures before it are fine. If all three fail, the last line is
    `mention: could not read the post — see the lines above`: nothing is launched and nothing is
    replied. Send the developer those lines (they hold Meta's error codes, never the token).
    `mention: reply via Instagram Login → 400 …` = the coin launched but the reply was refused
    (usually `instagram_business_manage_comments` missing from the token: step 12b).
    `not launched: no reply could be sent (the bot's IG_ID is unknown …)` = the server could not read
    the bot's own account (`GET /me`) from `IG_ACCESS_TOKEN`, so it launched nothing rather than a coin
    nobody would hear about: check the token (step 12b) and restart; the start-up log says
    `instagram: @instapaid.official id …` when it is right.
    `ignored: not a launch request` = the comment did not name the bot and the command;
    `mention: comment event ignored: a "comments" event with no comment id …` = Meta sent a shape the
    server does not know (the `webhook: entry` line above it shows the keys): send the developer both
    lines. Nothing at all = webhooks (steps 11d, 12c, 13, and step 14 for anyone without a role on the app).
18. [ ] **Check the coin** at the pump.fun link: the name and ticker fit the post, the picture is the
    post's photo, the website is the Instagram post, the description is "first light over the pines".
    `https://instapaid.fun/u/yourcreator` lists it.
19. [ ] **Check the post.** Open `https://instapaid.fun/posts/<address>.jpg`: the card, with the
    photo, the ticker, the name, "for @yourcreator" and the claim link, all readable. Within a few
    minutes @instapaid.official's feed has it, with the caption @mentioning @yourcreator, and the creator
    account gets a notification that it was mentioned. If not: Logs lines starting `poster:`
    (`publishing limit … 400` or `POST media … 403` = `instagram_business_content_publish` missing from the
    token).
20. [ ] **One claim.** Trade a little of the coin on pump.fun (buy about 0.1 SOL and sell it back) so a
    few fees build up. Then, logged in as the creator: `https://instapaid.fun/claim` → it shows a code
    → DM that code to @instapaid.official → the page moves on by itself → paste a wallet address →
    Claim. Check the SOL arrived. ("Under 0.001 SOL so far" means trade a bit more first.)
21. [ ] **The opt-out path.** Render → the service → **Shell** (if the prompt is not in the `server`
    folder, run `cd server` first): `npm run block -- yourcreator "launch test"`, then comment again from the fan account: the reply is
    "yourcreator has asked not to have coins made for them." (no @, and only once per creator, so the
    creator is not notified again and again). Then `npm run unblock -- yourcreator`.
    Remember: posts already on the feed are not removed by blocking — Instagram's API cannot delete
    posts; delete them in the Instagram app (the post's ••• menu → Delete).

## Part 6 — Open it up

22. [ ] **Decide on the auto-poster.** It stays on (`AUTO_POST=1`) from step 15. The defaults post at
    most 25 coins a day, 20 minutes apart, skip coins older than 24 hours, post comment launches before
    website launches, and post at most one coin per creator a month (`POST_CREATOR_GAP_DAYS`).
    Website launches are posted only after Claude checks the name, ticker and picture the launcher
    chose; if you would rather never show a stranger's choices, set `POST_WEB_LAUNCHES` = `0`. Watch the account for
    the first week (reach, reports, any warning from Instagram about spam) and lower
    `POST_MAX_PER_DAY` or set `AUTO_POST=0` if needed. Three failed posts in a row pause posting for an
    hour by themselves (the Logs say so).
23. [ ] **Spending caps.** `MAX_SERVER_LAUNCHES_PER_DAY` (20) × about 0.02 SOL is what comment launches
    can cost you a day. Keep the server wallet above `MIN_FEE_PAYER_SOL` plus that.
24. [ ] **Keep safe copies** of `VAULT_MASTER_KEY` (step 8) and know how to reach Render's disk
    snapshots. Set the calendar reminder for `IG_ACCESS_TOKEN` (step 11b).
25. [ ] **Legal.** Read "Things to decide before launch" in the README with your lawyer — coins named
    after real people, the custodial vaults, and posting about creators who never asked.
26. [ ] **Announce** — the extension's store listing, the site, and a first post from
    @instapaid.official explaining how creators claim.

## When a creator asks to be left out

`npm run block -- <their username> "<why/when>"` in Render's Shell, in the `server` folder
(`npm run block -- list` shows everyone blocked). It stops new coins (comments and
the website) and skips their waiting posts, and prints the posts already made — delete those by hand
in the Instagram app. Tell them their existing coins' fees are still theirs to claim at
`instapaid.fun/claim`.
