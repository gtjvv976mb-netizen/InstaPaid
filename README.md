# InstaPaid

Launch a pump.fun coin for any Instagram account, from a browser extension. The coin's creator fees
build up for that account, and **only the verified owner of that account can claim them**, like
[telepaid](https://telepaid.app/) does for Telegram.

```
extension/   Chrome (MV3) extension: "Launch a coin" on instagram.com profiles, with the account's totals
server/      Node + Express + SQLite: launch, Instagram DM verification, claims, and the web pages
```

## How it works

**Launch.** On a profile, the extension opens `/launch?u=<username>&pic=<profile picture>`. The
launcher names the coin and signs with their own wallet (Phantom, Solflare). They pay pump.fun's launch
cost and any first buy. The server builds the transaction with `@pump-fun/pump-sdk` `create_v2`, and
sets the coin's **creator** to a vault wallet belonging to that Instagram username. The launcher is
never the creator. The server signs as the new mint before handing the transaction over. If anyone
edits the transaction (to make themselves creator, say), the mint's signature no longer matches and
Solana rejects it. After it lands, `/api/launch/confirm` reads the bonding curve on-chain and lists the
coin only if its creator really is the vault.

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
npm test                 # 15 tests; the chain tests read mainnet (never send) and skip offline
npm start                # http://localhost:8787
```

Then load the extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Open
its options and set your server address, or change `DEFAULT_SERVER` in `extension/settings.js` before
you publish it.

### Instagram setup (one-time)

1. Make an Instagram **professional** account for the app (the one people DM codes to). Put its
   username in `IG_BOT_USERNAME`.
2. Create a Meta app with the **Instagram API with Instagram Login** product. Add that account, and
   generate a token with `instagram_business_basic` and `instagram_business_manage_messages`. That is
   `IG_ACCESS_TOKEN`; the app secret is `IG_APP_SECRET`.
3. Set the webhook callback to `https://<your host>/webhooks/instagram`, with verify token
   `IG_WEBHOOK_VERIFY_TOKEN`, and subscribe to `messages`.
4. Using messaging with the public (not only the app's testers) needs Meta's **App Review** for
   `instagram_business_manage_messages`, and Advanced Access.

People who claim can use personal accounts. Only the app's own account must be professional. An IGSID
is scoped to the app's account, so keep that account: a new one would see new IGSIDs, and vaults that
were already claimed could not be matched.

### Secrets

- `VAULT_MASTER_KEY`, `SESSION_SECRET`: `openssl rand -hex 32` each. **Losing `VAULT_MASTER_KEY`
  loses every unclaimed fee.** Back it up apart from the database.
- `FEE_PAYER_SECRET`: a fresh wallet with about 0.05 SOL. It only pays network fees for claims.
- The server refuses to start with any of these missing or malformed.

## Verified

- Unit and flow tests: webhook signatures, single-use and expiring codes, claim tokens that can't be
  forged or used after the claim window, one vault per account, rename and recycled-handle rules,
  images fetched only from Instagram's CDNs, and the disclaimer on every coin.
- On mainnet (read-only): the launch transaction, with and without a first buy, **passes simulation in
  the pump.fun program** (102k and 188k compute units) with the vault as creator. Collecting a real
  creator's fees with a separate fee payer also passes simulation, and the creator's balance rose by
  exactly the fees waiting. Collecting needs no signature from the creator; moving the money out of the
  vault does, and only the server holds that key.
- Browser: the launch and claim flows, at 1280px and 390px, with a stand-in wallet. The extension on a
  mock profile page adds the bar, shows the account's totals, opens the launch page with the profile
  picture, and removes itself when you navigate away.

Not yet run end to end with real SOL, a real pump.fun metadata upload, or a live Instagram webhook. Do
one small launch and claim on mainnet before you announce it.

## Things to decide before launch

- **This is custodial.** Until an account claims, its fees sit in a wallet whose key your server holds.
  Keep the host locked down, and consider a KMS/HSM for `VAULT_MASTER_KEY`.
- **Launching in someone's name.** Every coin's description says whose fees these are and that a fan
  launched it, not the account. The account page says the same. Still, a coin named after a real
  person can mislead buyers, and it may conflict with Instagram's and pump.fun's terms and with
  securities or consumer law where you operate. Get legal advice, and have a takedown path for
  accounts that object.
- **Metadata** goes to pump.fun's IPFS endpoint (`IPFS_UPLOAD_URL`), which is unofficial and can change.
- **The SDK's ESM build doesn't import** (`@coral-xyz/anchor` is CommonJS), so `src/pump.js` loads its
  CommonJS build with `createRequire`.
- **Rate limits** are in-memory (20 launches and 20 verifications an hour per IP). Use a shared store
  if you run more than one instance, and set `TRUST_PROXY=1` behind a proxy.
