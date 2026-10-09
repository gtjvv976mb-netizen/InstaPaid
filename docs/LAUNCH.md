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
       This kind of token lasts **60 days**, and the server renews it by itself: 24 hours after it
       first sees a pasted token, and every 7 days after that, it asks Instagram for a fresh 60-day token, keeps it in the database (sealed with `VAULT_MASTER_KEY`),
       and uses it at once; checked at every start and once a day. The Logs say
       `instagram token: renewed, valid ~60 days`. **No calendar reminder is needed. If the Logs warn**
       (`instagram token: WARNING — IT EXPIRES IN ~N DAYS …`, once a day from 10 days before the end,
       when renewing keeps failing; or `instagram token: WARNING — META REFUSED THE TOKEN IN USE …`,
       at once and then daily, when the token has expired or been revoked), generate a new token here and paste it into Render: a newly pasted
       `IG_ACCESS_TOKEN` always wins over the stored one. (Leave the old one in Render otherwise;
       the server knows its renewal descends from it.)
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
       as **`IG_ACCESS_TOKEN`**, replacing the one from step 11b. The server sees a new token at the
       next start, uses it instead of the stored one and renews it after 24 hours (step 11b).
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
       expired (step b again; with a new token pasted, the next start line is
       `instagram token: a new IG_ACCESS_TOKEN replaces the stored one`). `webhook not subscribed … (#…)` = the line says what Meta refused: most
       often a token without `instagram_business_manage_comments`.
    e. Leave **`IG_USER_ID`** and **`IG_FB_ACCESS_TOKEN`** empty, and **`COMMENT_LAUNCHES`** at `1`
       (`0` switches comment launches off without touching the token; DMs and the poster go on).

13. [ ] **Testers (before App Review).** While the app is in Development mode, Instagram only works for
    people with a role on the app. App → **App roles** → **Roles** → add the people who will test
    (as Testers), and in the Instagram product add their Instagram accounts as **Instagram testers**;
    each tester accepts the invite in Instagram (Settings → Apps and websites → Tester invites).
    Use **your own test accounts** as "creators" for testing — never a real person's account.
    **Caution (6 Oct 2026):** Instagram's webhooks page says real comment notifications go only to apps
    set to **Live**, with no exception for testers, and recent reports agree. The dashboard **Test**
    button works in Development mode, but a tester's real @mention may send nothing until the app is
    Live. See `docs/research/instagram-mentions.md`.

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
    Use the words and the screen recording script in **App Review: what to write and what to
    record** below (step 14b).

    **Plainly (updated 9 Oct 2026): real comment webhooks reach only a Live app.** Instagram's webhooks
    page gives no exception for role accounts (step 13's caution, `docs/research/instagram-mentions.md`),
    so in Development mode even a tester's @mention may send nothing. Business Verification is done
    (Brylliant Labs Inc.), so switch the app to **Live** (top of the app dashboard) without waiting for
    App Review. If real @mentions from public accounts still send nothing once Live, Advanced Access for
    `instagram_business_manage_comments` (App Review) is the remaining step; Meta's pages contradict
    each other on whether it is needed.

14a. [ ] **The owner page `/admin` (Instagram login, for the App Review recording).**
    Meta's review of `instagram_business_manage_comments` wants to see "the complete Instagram login
    process" in the app and a comment created, updated and deleted. That is `https://instapaid.fun/admin`:
    it signs in with Instagram (Business Login) and lets **only @instapaid.official** in (any other
    account sees "This page is only for @instapaid.official" and nothing is stored). Signed in, it
    lists the account's posts and their comments, and can comment, reply, hide / unhide and delete,
    with the token from that sign-in (sealed in a 1-hour cookie; never logged). It also lists the
    latest comment-launch requests.
    a. Meta app → **Instagram** → **API setup with Instagram login** → copy the **Instagram app ID**
       into Render as **`IG_APP_ID`** (Environment → Add → Save; Render redeploys). Without it,
       `/admin` says "Owner page not configured".
    b. Same page → **Set up Instagram business login** (**Business login settings**) → **OAuth
       redirect URIs** → add exactly `https://instapaid.fun/admin/callback` → **Save**. (A different
       address, `www.`, or a trailing slash makes Instagram refuse the sign-in with "Invalid redirect_uri".)
    c. Open `https://instapaid.fun/admin` → **Log in with Instagram** → sign in as @instapaid.official
       → allow → the page says **Signed in as @instapaid.official**. The Logs say
       `admin: @instapaid.official signed in`; a refusal from Meta is logged as `admin: <action> → <status> (#code) message`.

14b. **App Review: what to write and what to record.** App → **App Review** → **Permissions and
    features** → **Request advanced access** for each permission below. Paste the description, upload
    the recording (English captions on screen: the steps' words below make good captions), and give
    the reviewer a test login only if Meta asks for one (a tester account, never the owner's password).

    **`instagram_business_manage_comments`** — description:
    > InstaPaid lets fans launch a fan-made coin for an Instagram creator by commenting
    > "@instapaid.official make a token for this creator" under the creator's public post. We use
    > instagram_business_manage_comments to receive the comments that @mention @instapaid.official
    > (the webhook's comments field), read that comment and the post it is on, and reply under the
    > comment, as @instapaid.official, with the coin's details and the link where the creator can claim
    > its fees. The owner of @instapaid.official also moderates the comments on its own posts on our
    > owner page (instapaid.fun/admin, Instagram Business Login): viewing them, commenting, replying,
    > hiding / unhiding and deleting. We do not read or store comments that do not mention us, and we
    > do not comment on anyone else's posts except the one reply to the comment that asked us.

    **`instagram_business_manage_messages`** — description:
    > Creators prove they own their Instagram account before claiming their coin's fees: our claim page
    > shows a one-time code, the creator sends it to @instapaid.official by Instagram Direct, and the
    > bot replies to confirm (or, to a message without a code, with a short explanation of InstaPaid and
    > the creator's coins). We read only the text of messages sent to @instapaid.official and the
    > sender's username; we never message anyone who has not messaged us first.

    **`instagram_business_content_publish`** — description:
    > When a new coin goes live, @instapaid.official publishes one announcement post on its own feed
    > (a card with the coin's name, ticker and picture) that @mentions the creator, so the creator
    > learns the coin exists and can claim its fees. We publish only to @instapaid.official's own
    > account, at most one post per creator per 30 days and 25 a day.

    (`instagram_business_basic` needs only: "Reads @instapaid.official's own profile and posts, to
    know its account id and list its posts on the owner page.")

    **SCREEN RECORDING SCRIPT** (`instagram_business_manage_comments`; one take, about 3 minutes;
    the phone shows the Instagram app signed in as @instapaid.official, screen-mirrored or filmed beside
    the browser; a second phone, or the same one later, signed in as a **tester** account):
    1. Browser: open `https://instapaid.fun/admin`. Caption: "InstaPaid's owner page. It is only for
       @instapaid.official."
    2. Click **Log in with Instagram**. Caption: "Instagram Business Login".
    3. Instagram's sign-in and consent screen: sign in as @instapaid.official and show the two
       permissions it asks for (profile and posts; manage comments). Click **Allow**. Caption: "The
       owner grants instagram_business_basic and instagram_business_manage_comments."
    4. Back on `/admin`: point at **Signed in as @instapaid.official**. Caption: "Signed in."
    5. Click one of the posts under **Posts**; its comments open below. Caption: "The account's posts
       and their comments, read with instagram_business_manage_comments."
    6. **Create:** type a comment in **Add a comment** ("Thanks for stopping by!") → **Post comment**.
       It appears in the list. Caption: "Create a comment."
    7. Phone, Instagram app: open the same post → comments: the new comment is there. Caption: "The
       same comment in the Instagram app."
    8. **Update:** Instagram cannot edit a comment, so the page says so and updating is a reply or
       hiding. Browser: **Reply** under a comment → type → **Post reply**; then **Hide** on a comment
       (it gets a "Hidden" tag) → **Unhide**. Caption: "Update: reply to a comment, hide and unhide it."
    9. Phone: show the reply under the comment in the Instagram app (and, while it is hidden, that
       the hidden comment is gone for others — show it from the tester account). Caption: "The reply
       and the hidden comment in the Instagram app."
    10. **Delete:** browser: **Delete** on the comment made in step 6 → **Yes, delete**. It leaves the
        list. Caption: "Delete a comment."
    11. Phone: pull to refresh the post's comments: the comment is gone. Caption: "Gone in the
        Instagram app too."
    12. The bot's own use: tester account, Instagram app: under a post of a test "creator" account,
        comment `@instapaid.official make a token for this creator`. Caption: "A fan asks
        @instapaid.official for a coin in a comment."
    13. Wait for the reply (under a minute): show @instapaid.official's reply under that comment, with
        the coin's name and claim link. Caption: "The bot replies under the comment
        (instagram_business_manage_comments)."
    14. Browser: reload `/admin` and scroll to **Comment launch requests**: the request is the newest
        row, "Launched · for @<creator>". Caption: "The request as InstaPaid recorded it."
    15. Click **Log out**. Caption: "Log out."

    For `instagram_business_manage_messages`, record the claim in Part 5, step 20 (the claim page's
    code, DMed to the bot from the creator account, the bot's reply, the claim page turning to
    verified). For `instagram_business_content_publish`, record a coin going live and its announcement
    appearing on @instapaid.official's feed with the creator @mentioned (Part 5, steps 16–19).

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
    (With the legacy Facebook Login settings a fourth line may follow: a Facebook `mentions` event
    carries no comment text, so the post's owner alone does not end the search. If the post was
    read but no answer gave the comment, the last line is `mention: read the post but not the
    comment — see the lines above`, and again nothing is launched.)
    `mention: reply via Instagram Login → 400 …` = the coin launched but the reply was refused
    (usually `instagram_business_manage_comments` missing from the token: step 12b).
    `not launched: no reply could be sent (the bot's IG_ID is unknown …)` = the server could not read
    the bot's own account (`GET /me`) from `IG_ACCESS_TOKEN`, so it launched nothing rather than a coin
    nobody would hear about: check the token (step 12b) and restart; the start-up log says
    `instagram: @instapaid.official id …` when it is right.
    `ignored: not a launch request` = the comment did not name the bot and the command;
    `mention: comment event ignored: a "comments" event with no comment id …` = Meta sent a shape the
    server does not know (the `webhook: entry` line above it shows the keys): send the developer both
    lines. Nothing at all = webhooks: the app must be **Live** for any real comment to arrive (step 14,
    `docs/research/instagram-mentions.md`); then check steps 11d, 12c and 13, and Advanced Access (step 14)
    if a Live app still gets nothing.
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

21a. [ ] **The launch lookup table (one-time, about 0.005 SOL).** A small account on chain that stores
    pump.fun's fixed addresses, so each takes 1 byte instead of 32 in every website launch and first
    buy. It leaves Phantom room for its safety checks. (The first buy is its own transaction, signed
    and sent by the launcher's wallet right after the coin is live.)
    Render → the service → **Shell** (`cd server` if needed):
    1. `npm run lookup-table` shows what it would hold (about 21 pump.fun addresses), the rent (about
       0.0043 SOL) and the fee payer's balance. It sends nothing.
    2. `npm run lookup-table -- --create` makes it, paid by the fee payer, and saves its address. It
       prints the Solscan links. The server uses it from the next launch on, no restart.
    3. Run `npm run lookup-table` again any time: it says whether the table still holds every address
       pump.fun uses. If pump.fun ever adds one, launches still work, a few bytes larger.
    The table holds no money and changes no coin. Only the fee payer could ever close it.

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
    snapshots. `IG_ACCESS_TOKEN` renews itself (step 11b): if the Logs ever show
    `instagram token: WARNING`, generate a new token and paste it into Render.
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
