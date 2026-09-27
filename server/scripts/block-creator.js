#!/usr/bin/env node
// A creator who asks not to have coins made for them:
//   npm run block -- <username> [note]      no new coins for them, by comment or on the website,
//                                            and their coins still waiting to be posted are skipped
//   npm run unblock -- <username>           lift it (also: npm run block -- unblock <username>)
//   npm run block -- list                   who is blocked
// Posts already on @instapaid.official stay up: Instagram's API cannot delete them. Delete those in
// the Instagram app (the post's ••• menu → Delete).
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { blockCreator, unblockCreator } from '../src/blocks.js';

let args = process.argv.slice(2);
let mode = 'block';
if (args[0] === '--unblock' || args[0] === 'unblock') { mode = 'unblock'; args = args.slice(1); }
else if (args[0] === 'list' || args[0] === '--list') mode = 'list';

const db = openDb(config.dbPath);
try {
  if (mode === 'list') {
    const rows = db.prepare('select username, created_at, note from creator_block order by created_at').all();
    if (!rows.length) console.log('Nobody is blocked.');
    for (const r of rows) console.log(`@${r.username}  since ${new Date(r.created_at).toISOString().slice(0, 10)}${r.note ? `  (${r.note})` : ''}`);
  } else if (!args[0]) {
    console.error('Usage: npm run block -- <username> [note]   |   npm run unblock -- <username>   |   npm run block -- list');
    process.exitCode = 2;
  } else if (mode === 'unblock') {
    const was = unblockCreator(db, args[0]);
    console.log(was ? `Unblocked @${args[0].replace(/^@/, '').toLowerCase()}.` : `@${args[0].replace(/^@/, '').toLowerCase()} was not blocked.`);
  } else {
    const skipped = blockCreator(db, args[0], args.slice(1).join(' ') || null);
    const u = args[0].replace(/^@/, '').toLowerCase();
    console.log(`Blocked @${u}: no new coins for them, and no posts.${skipped ? ` Skipped ${skipped} waiting post${skipped === 1 ? '' : 's'}.` : ''}`);
    const posted = db.prepare(
      `select j.permalink from post_job j join token t using (mint) where t.username = ? and j.status = 'posted'`
    ).all(u);
    if (posted.length) {
      console.log(`Already posted about @${u} (delete these in the Instagram app; the API cannot):`);
      for (const p of posted) console.log(`  ${p.permalink ?? '(link unknown)'}`);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
