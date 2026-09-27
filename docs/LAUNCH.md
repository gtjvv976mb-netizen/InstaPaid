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
   Settings → Account type and tools → Switch to professional account → **Business**). Keep it
   **public**. Give it a profile picture and a bio that says what it is ("Fan-made coins for
   creators. Creators: claim your fees at instapaid.fun").
6. [ ] **A Facebook Page** for InstaPaid, owned by you, and **linked to @instapaid.official**
   (Facebook → the Page → Settings → Linked accounts → Instagram → Connect). Comment launches and
   the auto-poster work through this Page.
7. [ ] **A Meta developer account** (developers.facebook.com, log in with the Facebook account that
   owns the Page). Ideally also a **Meta Business portfolio** (business.facebook.com) that owns the
   Page and the Instagram account: it lets you make a token that never expires (step 12b).

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
      `ANTHROPIC_API_KEY`. The Instagram ones (`IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `IG_USER_ID`,
      `IG_FB_ACCESS_TOKEN`, `META_APP_SECRET`) come in Part 4; the server will not start until
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

The server talks to Instagram two ways, both in **one Meta app**: *Instagram Login* (people DM their
claim code to @instapaid.official) and *Facebook Login* (reading the comments that mention the bot,
replying to them, and posting on the bot's feed).

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

12. [ ] **Connect Facebook Login (comment launches and the auto-poster).**
    a. In the same app, add the product **Facebook Login for Business** (if Meta asks) and
       **Webhooks**. In **Webhooks**, pick the object **Instagram**, same callback URL and verify token,
       **Verify and save**, then subscribe the field **`mentions`**.
    b. Make the token. Best: a **system user token** (it does not expire). business.facebook.com →
       Settings → **Users → System users** → **Add** (role Admin) → **Assign assets**: the Facebook
       Page (full control), the Instagram account, and the InstaPaid app → **Generate new token** for
       the app with these permissions:
       `instagram_basic`, `instagram_manage_comments`, `instagram_content_publish`,
       `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata`
       (and `business_management` if Meta offers it).
       Copy it into Render as **`IG_FB_ACCESS_TOKEN`**.
       (Without a Business portfolio: Graph API Explorer → your app → "Get User Access Token" with the
       same permissions → exchange it for a long-lived one → `GET /me/accounts` gives the Page's token,
       which does not expire.)
    c. Find the bot's Instagram id: Graph API Explorer → paste the token →
       `GET /me/accounts?fields=name,instagram_business_account{id,username}` → the
       `instagram_business_account.id` next to `instapaid.official` (a long number starting with
       `1784…`). Copy it into Render as **`IG_USER_ID`**. It is not the Page id.
    d. Install the app on the Page: in Graph API Explorer with the **Page** token, run
       `POST /<page-id>/subscribed_apps?subscribed_fields=feed` (Meta sends Instagram mentions only to
       apps subscribed to the linked Page, on any Page field; `feed` will do). The answer is
       `{"success":true}`.

13. [ ] **Testers (before App Review).** While the app is in Development mode, Instagram only works for
    people with a role on the app. App → **App roles** → **Roles** → add the people who will test
    (as Testers), and in the Instagram product add their Instagram accounts as **Instagram testers**;
    each tester accepts the invite in Instagram (Settings → Apps and websites → Tester invites).
    Use **your own test accounts** as "creators" for testing — never a real person's account.

14. [ ] **App Review (to open it to everyone).** App → **App Review** → **Permissions and features**:
    request **Advanced Access** for `instagram_business_manage_messages`, `instagram_manage_comments`,
    `instagram_content_publish`, `instagram_basic`, `pages_read_engagement`, `pages_show_list`,
    `pages_manage_metadata`. For each one Meta wants a sentence on how it is used and a screen
    recording. Say plainly:
    - messages: "Creators DM a one-time code to @instapaid.official to prove they own their account
      before claiming their coin's fees."
    - comments: "When someone comments '@instapaid.official make a token' under a public post, we read
      that comment and reply to it with the coin's link."
    - content publish: "@instapaid.official posts an announcement of new coins on its own feed and
      @mentions the creator in the caption so they can claim."
    Record the flows from Part 5 (steps 16–21) with a tester. Business verification of your portfolio may be asked
    for (company documents). When approved, switch the app to **Live** (top of the app dashboard).
    Webhooks for the public arrive only in Live mode.

## Part 5 — The first real test

Do this with **your own two test accounts**: one as the fan who comments, one public professional
account as the "creator" (with one photo post). It spends about 0.02 SOL.

15. [ ] **Turn the poster on for the test.** First check the card's fonts on Render itself: Render →
    the service → **Shell** (`cd server` if needed) → `npm run sample-card`. Open the three addresses it
    prints: a Japanese, an Arabic and a Latin name, each drawn in real letters (never rows of little
    boxes). Then Render → Environment → `AUTO_POST` = `1` → Save. After the redeploy, the Logs say
    `auto-poster on: at most 25 a day, 20 min apart`. Make sure `ANTHROPIC_API_KEY` is set: without it,
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
    No reply? Render → Logs. `mentioned_comment 403/400` = a missing permission (step 12b);
    `post owner unknown` = Meta did not send the post's username (tell the developer: this is the
    first thing to check with a real comment); nothing at all = webhooks (steps 11d, 12a, 12d, 13).
18. [ ] **Check the coin** at the pump.fun link: the name and ticker fit the post, the picture is the
    post's photo, the website is the Instagram post, the description is "first light over the pines".
    `https://instapaid.fun/u/yourcreator` lists it.
19. [ ] **Check the post.** Open `https://instapaid.fun/posts/<address>.jpg`: the card, with the
    photo, the ticker, the name, "for @yourcreator" and the claim link, all readable. Within a few
    minutes @instapaid.official's feed has it, with the caption @mentioning @yourcreator, and the creator
    account gets a notification that it was mentioned. If not: Logs lines starting `poster:`
    (`publishing limit … 400` or `POST media … 403` = `instagram_content_publish` missing from the
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
