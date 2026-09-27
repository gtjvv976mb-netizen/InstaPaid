/**
 * Which vaults a verified Instagram identity may claim.
 *
 * - A vault already bound to this identity's IGSID: yes, whatever the username is today
 *   (they renamed; the money follows the person, not the handle).
 * - An unbound vault whose username is the one this identity has now: yes, and claiming binds it.
 * - A vault bound to a different IGSID: never — the handle was given up and taken by someone else.
 */
export function claimableAccounts(db, { igsid, username }) {
  return db.prepare(
    `select * from account
      where igsid = @igsid
         or (igsid is null and username = @username)
      order by created_at`
  ).all({ igsid, username: username.toLowerCase() });
}

/** Bind an unbound vault to the identity. Returns false if someone else bound it first. */
export function bindAccount(db, username, igsid) {
  const r = db.prepare(
    `update account set igsid = @igsid where username = @username and (igsid is null or igsid = @igsid)`
  ).run({ username, igsid });
  return r.changes === 1;
}
