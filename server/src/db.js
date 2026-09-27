import Database from 'better-sqlite3';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    -- One vault per Instagram username. The vault is the on-chain "creator" of every token
    -- launched for that account, so all its creator fees accrue to one pump.fun creator vault.
    create table if not exists account (
      username      text primary key,           -- lowercase, as launched
      vault_pubkey  text not null unique,
      vault_secret  text not null,              -- AES-256-GCM sealed, aad = 'vault:' || username
      igsid         text,                       -- bound on the first verified claim; never changes after
      created_at    integer not null
    );
    create index if not exists account_igsid on account(igsid);

    create table if not exists token (
      mint          text primary key,
      username      text not null references account(username),
      name          text not null,
      symbol        text not null,
      launcher      text not null,
      status        text not null check (status in ('prepared','live')),
      signature     text,
      created_at    integer not null
    );
    create index if not exists token_username on token(username);

    -- A person proving they own an Instagram account: they DM "code" to the bot.
    create table if not exists verification (
      id            text primary key,           -- secret, held only by the browser that started it
      code          text not null unique,
      status        text not null check (status in ('pending','verified','expired')),
      igsid         text,
      username      text,
      created_at    integer not null,
      expires_at    integer not null
    );

    create table if not exists claim (
      id            integer primary key autoincrement,
      username      text not null references account(username),
      igsid         text not null,
      destination   text not null,
      lamports      integer not null,
      platform_fee  integer not null,
      collect_sig   text,
      transfer_sig  text,
      created_at    integer not null
    );
  `);
  return db;
}
