# InstaPaid

**Continuing work? Read `docs/HANDOFF.md` first** (its "Start here" section): what is live, what is blocked
(comment launches wait on Meta), what the owner still has to do, and the rules that hold. Texts already written
for the owner are in `docs/OWNER-DRAFTS.md`.

- Server: `server/` (Node, Express, SQLite). Tests: `cd server && CHAIN_TEST=0 npm test`.
- Deploy: Render auto-deploys `main`. Work on the branch your session is given, one PR per change; the owner
  merges (or says "MERGE" and you merge it after checking it is clean).
- Commit as `InstaPaid <sk5ydyhbf2@privaterelay.appleid.com>`.
- Never paste secrets. Mainnet actions beyond the existing launch paths need the owner's yes.
- Pip (`server/public/pip2d.js`) never really clicks anything, and visitors cannot steer him. After editing
  `pip2d.js`, update its `?v=` hash in `server/public/mascot.js`.
- No Apple logo or "iPhone" wording on the site.
