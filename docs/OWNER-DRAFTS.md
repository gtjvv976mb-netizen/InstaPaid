# Texts written for the owner (1–9 Oct 2026)

Ready-to-paste texts from the 1–9 Oct session, so a session on another account has them. Facts in them
(sizes, addresses) were checked on mainnet when written.

## Meta: Tech Provider access verification (due 30 Nov 2026, else the business is restricted to 1 app)

For Brylliant Labs Inc. Caution given to the owner: Meta's "Tech Provider" means serving *client businesses*;
InstaPaid mostly uses the API on its own account. If the form offers "my business uses Platform Data only for
its own app", that may be the more accurate path. Status: owner was filling it in; not confirmed submitted.

- **Which options describe your business:** SaaS Platform.
- **How Platform Data is used:**
  > InstaPaid (instapaid.fun) is a web service that lets fans start a fan coin for an Instagram creator they
  > like, and lets the creator alone claim the fees it earns. A fan asks by leaving a comment that mentions our
  > Instagram account, @instapaid.official, under the creator's public post.
  >
  > We use Instagram data to run that service. We read comments that mention our account so we know a fan asked
  > for a coin and under which post. We read that post's caption, photo and the creator's username so the coin
  > can be named and pictured after the post and the creator can be tagged. We reply to the fan's comment from
  > our own account to confirm the coin and link to it, and we publish a post on our own account announcing it.
  > Our staff also use the service to view, reply to, hide or delete comments on our own account's posts.
  >
  > Creators use the service to find their coin and claim its fees on our website. Fans use it to request and
  > follow coins. We do not sell or share Instagram data with anyone else, and we delete it on request as
  > described in our privacy policy.
- **Multiple business portfolios:** No.
- **Website:** https://instapaid.fun (privacy and terms pages name Brylliant Labs Inc. as the operator).

## Meta: App Review (Advanced Access)

The permission descriptions and the screen-recording script are in `docs/LAUNCH.md` step 14b. Record steps
1–11 only (the owner page: Instagram login, create / reply / hide / unhide / delete a comment). Steps 12–13 (a
fan's comment and the bot's reply) cannot work before approval and Live mode. Note for the reviewer:
> The automatic reply to a comment that @mentions @instapaid.official needs Advanced Access, so it cannot be
> demonstrated before approval. The recording shows the owner page's comment management with the same permission.

Request Advanced Access for at least `instagram_business_manage_comments` and `instagram_business_basic`
("Reads @instapaid.official's own profile and posts, to know its account id and list its posts on the owner
page."). Then switch the app to **Live** (App settings → Basic: privacy `https://instapaid.fun/privacy`, terms
`https://instapaid.fun/terms`, data deletion `https://instapaid.fun/data-deletion`, icon
`brand/app-icon-1024.png`, a category). Why Live matters: `docs/research/instagram-mentions.md`.

## Phantom (ticket 414019, William)

Sent on 2 Oct (after #30), as the owner's reply; William's answer is awaited:
> The change is now live on instapaid.fun. Here is a coin launched with it:
> - Coin page: https://instapaid.fun/u/veefriends
> - Creator on Instagram: https://instagram.com/veefriends
> - Transaction: https://solscan.io/tx/3pAUZ7XrRvUpEVcZwgn3fH1Y7pJu886jyWZU2agYEGMoFEPGdeh15uYvDtP2XRLMmPFWydpHsPn8KHdvXYGqbz3a
>
> With Phantom's Lighthouse checks included, it is 732 bytes, 500 under the limit. The first buy is now a
> separate transaction.

## The InstaPaid coin (the owner's own pump.fun coin, launched by the owner on pump.fun)

- Name **InstaPaid**, ticker **INSTAPAID**. Logo `brand/app-icon-1024.png`, banner `brand/banner-1500x500.png` (3:1).
- Description:
  > The coin of InstaPaid, where fans launch coins for Instagram creators. Comment "@instapaid.official make a
  > token for this creator" under any public post, and we launch a pump.fun coin named after that post. Its
  > creator fees go to the creator, and only they can claim them.
  >
  > instapaid.fun · Instagram: @instapaid.official
  >
  > A meme coin with no promise of value or returns.
- Links: website https://instapaid.fun; Instagram https://www.instagram.com/instapaid.official/ (pump.fun has
  no Instagram field, so it is in the description). No X or Telegram account is known.
- Caution given: a coin launched by the company behind the product reads more like a stake in InstaPaid than
  fan coins do. No promises of price, profit or revenue sharing; lawyer to check.

## Instagram carousel captions (`brand/post/`)

Slides 1–6 in order. Until comment launches work for the public, post with `slide-6.jpg` and:
> Here's how InstaPaid works 👇
>
> 1️⃣ Find a public post from a creator you love.
> 2️⃣ Comment: @instapaid.official make a token for this creator
> 3️⃣ We launch a coin on pump.fun, named from the post, and reply with the link.
> 4️⃣ Only the creator can claim its fees. They DM us a code to prove it's them.
>
> ⏳ Comment launches are almost live. We've asked Meta to approve our app's full access to Instagram's API.
> Once it's approved, any comment tagging us can launch a coin.
>
> Until then, launch one yourself at instapaid.fun/launch 🚀
>
> Fan-made meme coins on pump.fun. Not financial advice. Not affiliated with Instagram or Meta.
>
> #InstaPaid #pumpfun #solana #memecoin #creators

Once a public account's comment has really launched a coin, swap in `slide-6-live.jpg` and open the caption
with "Comment launches are LIVE 🚀", replacing the ⏳ paragraph with "Or launch one yourself at
instapaid.fun/launch". Do not post the live version before that test passes.
