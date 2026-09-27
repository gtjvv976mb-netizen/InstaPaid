// Creators who asked not to have coins made for them. Added with `npm run block -- <username>`.
// A blocked creator gets no new coins by comment or on the website, and no posts from us.
import { normalizeHandle } from './handles.js';

export function isBlocked(db, username) {
  return !!db.prepare('select 1 from creator_block where username = ?').get(String(username ?? '').toLowerCase());
}

/** Block a creator and skip their coins still waiting to be posted. Returns the number skipped. */
export function blockCreator(db, username, note = null, now = Date.now()) {
  const u = normalizeHandle(username);
  if (!u) throw new Error(`not an Instagram username: ${username}`);
  return db.transaction(() => {
    db.prepare(
      `insert into creator_block (username, created_at, note) values (?, ?, ?)
       on conflict(username) do update set note = coalesce(excluded.note, creator_block.note)`
    ).run(u, now, note || null);
    return db.prepare(
      `update post_job set status = 'skipped', last_error = 'creator opted out'
        where status = 'queued' and mint in (select mint from token where username = ?)`
    ).run(u).changes;
  })();
}

/** Lift a block. Posts skipped while it was on stay skipped. */
export function unblockCreator(db, username) {
  const u = normalizeHandle(username);
  if (!u) throw new Error(`not an Instagram username: ${username}`);
  return db.prepare('delete from creator_block where username = ?').run(u).changes > 0;
}
