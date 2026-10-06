# How @mentions reach InstaPaid (research, 6 Oct 2026)

Why this exists: on 6 Oct a real comment "@instapaid.official make a token for this creator" under @foxstarhong's video
produced no webhook at all, while Meta's dashboard Test for `comments` reached the server and was processed. A research
workflow (three independent search angles, then one skeptic per question re-checking the sources) looked at Meta's docs
and developer reports. Statuses: confirmed = survived checking; corrected = the first answers were partly wrong;
unresolved = the evidence does not settle it.

## Conclusion

1. In theory yes, under the "comments" field, but nobody has shown it working. Instagram Login has no separate mentions field: "@mention on apps that use Business Login for Instagram are included in the comments notifications" (https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md). Captured deliveries look like entry[].changes[{field:"comments", value:{id, from{id,username}, text, media{id, media_product_type}}}] (https://raw.githubusercontent.com/djeknet/n8n-master-workflows/HEAD/Social_Media/Automate_Instagram_Comment_Responses_with_Google_Sheets_CRM_Tracking.json). Nothing in the payload marks it as a mention or names the post's owner. No doc and no captured payload shows a mention on another account's post reaching an Instagram Login app. The account that owns the post must be a public professional account.

2. Likely causes, most likely first:
a) Development mode. "Your app must be set to Live ... for Meta to send webhook notifications" (https://developers.facebook.com/documentation/instagram-platform/webhooks.md). In one report, comment events from role accounts stopped until the app went Live (https://community.n8n.io/t/instagram-creator-account-webhook-for-comments-not-firing-to-n8n/182907). In another, an Instagram Login app in Development mode got zero requests (https://developers.facebook.com/community/threads/4288466748042535/). The dashboard Test skips this check, which is why it reached the server.
b) No Advanced Access. The webhooks page requires it for comments. But https://developers.facebook.com/documentation/instagram-platform/app-review says Standard Access is enough for an account you own. The docs contradict each other.
c) An Instagram Login limitation: possible, but unproven (see 1).
d) Wrong field subscribed: least likely. "mentions" is documented only for Facebook Login (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/mentions.md).

3. In the dashboard: check that "comments" is subscribed. Set the app to Live, which needs a business that has passed Business Verification (https://developers.facebook.com/documentation/development/create-an-app/other-app-types/instagram-apis.md). If real events still don't arrive, get Advanced Access for instagram_business_basic and instagram_business_manage_comments through App Review.

In the server:
- Adding "mentions" to subscribed_fields on graph.instagram.com is undocumented and is not the fix.
- Keep the current parser. It already accepts both payload shapes, flat and changes[], for both fields (/home/user/InstaPaid/server/test/iglogin.test.js line 111).
- Use the webhook payload itself (value.id, text, from.username, media.id), and don't drop the event when the lookups fail.
- mentioned_comment and mentioned_media are documented only as GET https://graph.facebook.com/v25.0/{ig-user-id}?fields=mentioned_comment.comment_id({comment-id}){...}. They need a Facebook User token with instagram_basic, instagram_manage_comments and pages_read_engagement (https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment.md).
- The Instagram Login guide offers only GET /<IG_ID>/tags and POST /<IG_ID>/mentions (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions.md). GET /<media-id> works only for the media's owner.
- So the only documented way to find out who the creator is: the server's existing Facebook Login fallback (IG_USER_ID + IG_FB_ACCESS_TOKEN).
- To also receive mentions through Facebook Login, subscribe the "mentions" field and install the app on the linked Page with POST /{page-id}/subscribed_apps. The server does not do that today.

4. Still unknown:
- whether mentions on other accounts' posts reach an Instagram Login app at all;
- whether Live mode with Standard Access is enough;
- how graph.instagram.com responds to "mentions" in subscribed_fields;
- whether mentioned_comment works with an Instagram Login token. The only test used a dummy comment ID and a token without instagram_business_manage_comments (https://raw.githubusercontent.com/nikonotnicotine/Uranus_Imessage/HEAD/scripts/probe-token-scopes.mjs).

Once the app is Live, have a public account with no role on the app post the mention, log the raw request body, and call mentioned_comment with that real comment ID.

## The four questions

### Q1 (unresolved): Does an @mention of @instapaid.official under someone else's post reach an Instagram Login app, and under which field?

Meta's current docs say yes. With Instagram (Business) Login there is no separate "mentions" event: an @mention "is included in the comments notifications", so it would arrive as field "comments". In real deliveries that field sits inside entry[].changes[], and the value is {id: comment ID, from{id, username}, text, media{id, media_product_type}}. Nothing in the payload marks the event as a mention or names the media owner. I found no official example, no captured payload and no first-hand report showing that a mention on ANOTHER account's media actually reaches an Instagram Login app, so whether it does is still unverified. InstaPaid's missing webhook does not settle the question either. Meta documents that webhooks are sent only to apps set to Live, and that "comments" webhooks need Advanced Access. A first-hand report from September 2025 says that even accounts with a role on the app no longer get real events while the app is in Development mode. The dashboard "Test" button bypasses all of these gates.

Claims the skeptic refuted or downgraded:

- Payload shape is wrong as stated by researcher 1: it gives entry[{id, time, field: "comments", value: {...}}], with field and value sitting directly on the entry. That copies Meta's malformed doc sample, which also has a missing comma. Real Instagram Login "comments" deliveries captured from Meta (user-agent "Webhooks/1.0 (https://fb.me/webhooks)", source IP 173.252.95.16) wrap them as entry[].changes[{field: "comments", value: {id, from{id, username}, text, media{id, media_product_type}}}]. Parsers should accept both shapes.
- Not refuted, but unverified: researcher 2 says a mention 'would presumably arrive as a comments event, with value.id holding the comment ID and value.media.id holding the other account's media ID'. No official doc and no captured payload confirms this for media the app user does not own. Meta's payload description covers only 'the Instagram user who commented on your app user's media'.
- The consultant blog's 'deliberately thin payload' claim ("media_id and comment_id. No caption, no username, no comment text") describes the Facebook Login "mentions" field. It does not describe Instagram Login, whose documented "comments" payload does carry from.username and text. The blog is a write-up of the docs, not a first-hand test. Its date (2026-09-14, per its metadata) matches researcher 3's 'September 2026'.
- Community code that handles field === 'mentions' on graph.instagram.com (riasistemas, juspay/xyne-spaces, Shudesu/ig-harness-oss) proves only that the handler exists and that Meta accepts the subscription. None of it shows a mention event that was actually received. This confirms researcher 3's caveat rather than contradicting the docs.

Sources:

- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md: "@mention on apps that use Business Login for Instagram are included in the `comments` notifications."
- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "| `mentions` | Included in the `comments` webhook notification | * `instagram_basic`<br>* `instagram_manage_comments`<br>* `pages_manage_metadata`<br>* `pages_read_engagement`<br>* `pages_show_list` | x |"
- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md: "The Instagram-scoped user ID of the Instagram user who commented on your app user's media"
- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "Your app must be set to **Live** in the App Dashboard for Meta to send webhook notifications"
- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "Advanced Access is required to receive `comments` and `live_comments` webhook notifications."

### Q2 (confirmed): Is the "mentions" webhook field available with Instagram Login?

Meta's current docs list `mentions` as a webhook field you can subscribe to only for the Instagram API with Facebook Login (a Page-linked account on graph.facebook.com). For Instagram Login (graph.instagram.com), the docs say @mentions are "included in the `comments` notifications". So subscribing to `comments`, as the server already does, is the documented way to get them. No official page and no community report says whether graph.instagram.com/me/subscribed_apps accepts, ignores or rejects `mentions` in subscribed_fields. Two open-source Instagram Login projects send it, but neither shows Meta's response, so that part is still unknown. Adding the field is not the documented fix in any case. The same webhooks page also lists two requirements that fit the missing webhook better than the field name: the app must be **Live**, and `comments` notifications need **Advanced Access**.

Claims the skeptic refuted or downgraded:

- None of the three claims was refuted. Two small corrections: (1) The create-an-app quote cuts the default list short. The full list has 8 fields (comments, live_comments, message_reactions, messages, messaging_optins, messaging_postbacks, messaging_referral, messaging_seen), and it still has no `mentions`, so the claim stands.
- (2) The community line "Meta ignores fields not applicable to the subscription target" is only an unchecked code comment in idivarts/backend-sls. Neither it nor the Shudesu guide shows Meta's actual answer to a subscribed_apps call that includes `mentions` on graph.instagram.com, so it does not prove the field is accepted or ignored.
- Related to the server's flow, outside Q2: the IG User mentioned_comment and mentioned_media reference pages document only graph.facebook.com with Facebook Login permissions (instagram_basic, instagram_manage_comments, pages_read_engagement). The Instagram Login Mentions guide points to GET /<IG_ID>/tags and POST /<IG_ID>/mentions instead, so the server's mentioned_comment/mentioned_media reads on graph.instagram.com are not documented for Instagram Login.

Sources:

- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "| `mentions` | Included in the `comments` webhook notification | * `instagram_basic`<br>* `instagram_manage_comments`<br>* `pages_manage_metadata`<br>* `pages_read_engagement`<br>* `pages_show_list` | x |"
- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md: "### `mentions` on comments #### Business Login for Instagram objects @mention on apps that use Business Login for Instagram are included in the `comments` notifications."
- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "curl -i -X POST "https://graph.instagram.com/v25.0/1755847768034402/subscribed_apps ?subscribed_fields=comments,messages &access_token=EAAFB...""
- https://developers.facebook.com/documentation/instagram-platform/webhooks.md: "- Apps must be set to **Live** in the App Dashboard to receive webhook notifications. - Advanced Access is required to receive `comments` and `live_comments` webhook notifications."
- https://developers.facebook.com/documentation/development/create-an-app/other-app-types/instagram-apis.md: "By default you are subscribed to all available webhooks for the Instagram product: comments, live_comments, message_reactions, messages, messaging_optins, messaging_postbacks, messaging_referral, messaging_seen"

### Q3 (unresolved): Do mentioned_comment / mentioned_media work with Instagram Login tokens?

This is unsettled. Meta documents mentioned_comment and mentioned_media only for Facebook Login: the reference pages show graph.facebook.com, a Facebook User token and instagram_basic/instagram_manage_comments/pages_read_engagement, and the Facebook Login Mentions guide lists them. The Instagram Login Mentions guide (graph.instagram.com) lists only GET /<IG_ID>/tags and POST /<IG_ID>/mentions, and no official page says either way whether the fields work with an Instagram Login token. The IG User reference lists both fields without the "Facebook Login only" label it gives collaborative_media, and the IG Comment reference, which covers both login types, tells readers to "use the Mentioned Comment node". The host on a reference page proves nothing, because the /mentions and /tags reference pages also show only graph.facebook.com, yet Meta puts both endpoints on graph.instagram.com. The only real test (Uranus_Imessage, 2026-09-13) got "nonexisting field" on graph.instagram.com, but it used a dummy comment ID, a token without instagram_business_manage_comments and possibly a Development-mode app. So it stays unknown until someone calls it with a real mention comment ID and a token that has instagram_business_manage_comments; under Instagram Login the "comments" webhook already carries comment_id, text, from.username and media.id.

Claims the skeptic refuted or downgraded:

- Overstated (community-evidence): "The evidence points to Facebook Login on graph.facebook.com only." The main documentary argument (the reference pages show only graph.facebook.com and Facebook Login permissions) does not tell the two apart. Meta's reference pages for POST /{ig-user-id}/mentions and GET /<IG_USER_ID>/tags also show only graph.facebook.com and a Facebook User token, yet the Instagram Login Mentions guide puts both on graph.instagram.com, and POST /mentions was seen working there on 2026-09-13.
- Overstated (community-evidence): the two SDKs (opencoredev/social-sdk, hookmyapp) are not independent evidence. Both say they took the rule from Meta's Instagram Login Mentions guide ('Meta's Instagram Login mentions guide documents only the tags edge...'), and social-sdk refuses the call 'before sending a request', so neither reports a test.
- Imprecise (community-evidence): the Uranus_Imessage probe did not send a bare /me?fields=mentioned_comment. scripts/probe-token-scopes.mjs sends fields=mentioned_comment.comment_id(1) with a dummy ID, using a token its own notes say lacks instagram_business_manage_comments, and the full error (code and node type) was not recorded. That makes the 'nonexisting field' result confounded, not conclusive.
- Caution, not a researcher claim: InstaPaid's own docs/LAUNCH.md line 'mention: read post via mentioned_comment → 400 (#10) Application does not have permission …' is an illustrative example of the log format, not an observed Meta response. It is not evidence either way.

Sources:

- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment: "GET https://graph.facebook.com/v25.0/{ig-user-id} ?fields=mentioned_comment.comment_id({comment-id}){{fields}} &access_token={access-token}"
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_media: "GET https://graph.facebook.com/v25.0/{ig-user-id} ?fields=mentioned_media.media_id({media-id}){{fields}} &access_token={access-token}"
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions: "All endpoints can be accessed via the `graph.instagram.com` host. #### Endpoints * `GET /<IG_ID>/tags` — to get the media objects in which a Business or Creator Account has been tagged * `POST /<IG_ID>/mentions` — to reply to a comment or media object caption that a Business or Creator Account has been @mentioned in by another Instagram user"
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/mentions: "GET /{ig-user-id}?fields=mentioned_comment — to get data about a comment that an Business or Creator Account has been @mentioned in"
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user: "| `collaborative_media_search` | Look up a specific collaborative media by ID. Access via field expansion. Available for Instagram API with Facebook Login only. |"

### Q4 (corrected): What must be true for real (non-Test) comment webhooks: Development mode, testers, Live, Advanced Access?

Instagram's own webhooks page says Meta sends real (non-Test) notifications only to apps set to Live, and it gives no exception for role users or testers. The general Graph API page does say Development-mode apps get notifications started by people with a role on the app, but for Instagram comments that rule is contradicted by Instagram's page and by recent reports: an n8n user in September 2025 saw role-account events stop until the app was Live, and a Meta forum thread on Instagram Login (Development mode, Standard Access, admin/tester commenting) got zero requests. So an app still in Development mode most likely gets no real comment or @mention event, whoever comments. Beyond Live mode, Meta's docs contradict each other. The webhooks page lists Advanced Access (App Review for instagram_business_basic and instagram_business_manage_comments) and Business Verification as required for comments, which include @mentions. But the Instagram Login Comment Moderation and Mentions guides, and the App Review scenario table, say Standard Access with no App Review is enough for a professional account you own and have added in the App Dashboard, and one project reports Live plus Standard Access with no Business Verification worked for its own accounts (shown first-hand only for story mentions). What is settled: the app must be Live, and the post's owner must be a public account. What is unknown: whether Live mode with Standard Access delivers @mention comments from the public, or whether Advanced Access is really needed. Going Live may itself need a business that has passed Business Verification, per the create-app guide. Separately, mentioned_comment and mentioned_media are documented only for Facebook Login (graph.facebook.com, instagram_basic, instagram_manage_comments, pages_read_engagement), not for Instagram Login.

Claims the skeptic refuted or downgraded:

- The claim that Meta's Instagram docs flatly require Advanced Access (App Review) plus Business Verification for comment and @mention webhooks under Instagram Login, with no exception. Only the webhooks page says this. Meta's Comment Moderation guide and its Instagram Login Mentions guide (both listing the comments webhook) say Standard Access is enough if the app serves accounts you own or manage and have added in the App Dashboard. The App Review page gives 'only for a business I own or manage, Instagram Login' as Standard Access with App Review not required. The official docs conflict, so 'Advanced Access required' is not established for an owner-run account like @instapaid.official.
- Researcher 1 says 'The Instagram pages themselves ... state Live plus Advanced Access with no exception for testers' (high confidence). That holds for the webhooks page only. Other Instagram Platform pages carve out Standard Access for accounts you own.
- Researcher 3 says role-user events never arrive in Development mode. That is not universal across fields. In an n8n thread from August 2025, the poster received Instagram DM webhooks from a tester account while in test mode. The comment-specific reports (n8n September 2025, Meta forum) still support no real comment events in Development mode.
- Researcher 3 uses the dala-ai PR as evidence that Advanced Access is the cause. That PR uses Facebook Login (instagram_manage_comments) and does not state its app mode, so it cannot rule out Development mode as the reason real comments never arrived.

Sources:

- https://developers.facebook.com/documentation/instagram-platform/webhooks: "Your app must be set to **Live** in the App Dashboard for Meta to send webhook notifications"
- https://developers.facebook.com/documentation/instagram-platform/webhooks: "- Apps must be set to **Live** in the App Dashboard to receive webhook notifications. - Advanced Access is required to receive `comments` and `live_comments` webhook notifications. - The Instagram professional account that owns the media objects [must be public to receive notifications for comments or @mentions.]"
- https://developers.facebook.com/documentation/instagram-platform/webhooks: "| `mentions` | Included in the `comments` webhook notification |"
- https://developers.facebook.com/docs/graph-api/webhooks: "Apps in development mode can only receive test notifications initiated through the app dashboard or notifications initiated by people who have a role on the app."
- https://developers.facebook.com/documentation/instagram-platform/comment-moderation: "#### Access Level * Advanced Access if your app serves Instagram professional accounts you don't own or manage * Standard Access if your app serves Instagram professional accounts you own or manage and have added to your app in the App Dashboard"
