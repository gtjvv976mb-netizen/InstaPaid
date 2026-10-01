# InstaPaid

**Continuing work? Read `docs/HANDOFF.md` first**: what is live, what was just shipped (the launcher bot,
the tabbed home page, Pip), what the owner still has to do, and the rules that hold.

- Server: `server/` (Node, Express, SQLite). Tests: `cd server && CHAIN_TEST=0 npm test`.
- Deploy: Render auto-deploys `main`. Work on `claude/epic-curie-4on4v4`, one PR per change; the owner merges.
- Commit as `InstaPaid <sk5ydyhbf2@privaterelay.appleid.com>`.
- Never paste secrets. Mainnet actions beyond the existing launch paths need the owner's yes.
- Pip (`server/public/pip2d.js`) never really clicks anything, and visitors cannot steer him. After editing
  `pip2d.js`, update its `?v=` hash in `server/public/mascot.js`.
- No Apple logo or "iPhone" wording on the site.
