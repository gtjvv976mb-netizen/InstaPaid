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
      lore          text,                       -- comment launches: the fan's lore Claude passed, else null
      source        text not null default 'web' check (source in ('web','comment')),
      post_permalink text,                      -- comment launches: the Instagram post it was asked under
      -- 'prepared': a website launch not confirmed yet, or a comment launch sent and not yet known
      -- to have landed (it still counts as that creator's coin and against the daily budget).
      status        text not null check (status in ('prepared','live')),
      signature     text,
      last_valid_height integer,                -- comment launches: the block height after which the send can no longer land
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

    -- One row per comment that asked for a coin, so a webhook retry never launches twice.
    create table if not exists comment_request (
      comment_id    text primary key,
      media_id      text not null,
      username      text,                       -- the post's owner, when Meta says
      status        text not null check (status in ('working','launched','existing','skipped','failed')),
      mint          text,
      note          text,
      created_at    integer not null
    );

    -- The auto-poster: one row per coin that went live while posting was on. The mint is the key,
    -- so a coin is posted at most once; container_id is stored before media_publish so a restart
    -- can tell whether the post already went out.
    create table if not exists post_job (
      mint            text primary key references token(mint),
      status          text not null check (status in ('queued','posting','posted','failed','skipped')),
      attempts        integer not null default 0,
      container_id    text,
      media_id        text,
      permalink       text,
      last_error      text,
      created_at      integer not null,
      next_attempt_at integer not null,
      posted_at       integer
    );
    create index if not exists post_job_status on post_job(status, next_attempt_at);
    create index if not exists post_job_posted on post_job(posted_at);

    -- Creators who asked not to have coins made for them (npm run block).
    create table if not exists creator_block (
      username      text primary key,
      created_at    integer not null,
      note          text
    );

    -- Small durable settings, e.g. the poster's circuit breaker.
    create table if not exists kv (
      key           text primary key,
      value         text
    );

    -- The Instagram token in use (src/igtoken.js), one row. Instagram Login tokens last 60 days and
    -- are renewed here, so the renewed one must outlive a restart; IG_ACCESS_TOKEN stays what was pasted.
    create table if not exists ig_token (
      id            integer primary key check (id = 1),
      token         text not null,              -- AES-256-GCM sealed under VAULT_MASTER_KEY, aad = 'ig_token'
      env_hash      text not null,              -- HMAC of the IG_ACCESS_TOKEN this token descends from (a new paste wins)
      source        text not null check (source in ('env','renewed')),
      refreshed_at  integer not null,           -- when this token was pasted (first seen) or renewed
      expires_at    integer not null            -- renewed: from Meta's expires_in; pasted: assumed 60 days from first seen; now when Meta refuses it (190)
    );

    -- Coin addresses ending in "pump", found in the background (src/mintpool.js) so a launch never
    -- waits for one. A row is deleted as it is handed out: no address is offered twice.
    create table if not exists mint_key (
      pubkey        text primary key,
      secret        text not null,              -- AES-256-GCM sealed under VAULT_MASTER_KEY, aad = 'mint:' || pubkey
      created_at    integer not null
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
  migrate(db);
  return db;
}

/** Columns added after a table first shipped. Additive only, so an existing database upgrades in place. */
const ADDED_COLUMNS = [
  ['token', 'post_permalink', 'text'],
  ['token', 'last_valid_height', 'integer'],
];

export function migrate(db) {
  db.transaction(() => {
    for (const [table, column, decl] of ADDED_COLUMNS) {
      const has = db.prepare(`pragma table_info(${table})`).all().some((c) => c.name === column);
      if (has) continue;
      db.exec(`alter table ${table} add column ${column} ${decl}`);
      // Before post_permalink, a comment launch's lore was written by Claude (or a fixed fallback),
      // not by a fan. The pages now label lore "Fan lore", so that text goes.
      if (table === 'token' && column === 'post_permalink') db.exec(`update token set lore = null where source = 'comment'`);
    }
  })();
}
