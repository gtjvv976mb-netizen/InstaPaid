// The owner's page: sign-in state, the bot's posts, one post's comments (create, reply, hide /
// unhide, delete) and the latest comment-launch requests. Every change is one call to /admin/api/*
// with the session's CSRF token in X-CSRF.
const $ = (s) => document.querySelector(s);
let csrf = null;
let current = null; // the selected post

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf': csrf ?? '' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { signedOut('Your sign-in ran out. Log in with Instagram again.'); throw new Error(j.error || 'Signed out.'); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function say(kind, text) {
  // Beside the comments while a post is open (where the change shows), else at the top.
  const post = !$('#app').hidden && !$('#post').hidden;
  $(post ? '#status' : '#post-status').hidden = true;
  const el = $(post ? '#post-status' : '#status');
  el.className = `note ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter(Boolean));
  return e;
};
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `/icons.svg#${id}`);
  s.append(u);
  return s;
};
const when = (t) => {
  if (!t) return '';
  const d = new Date(typeof t === 'number' ? t : String(t).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function signedOut(message) {
  csrf = null;
  $('#app').hidden = true;
  $('#who').hidden = true;
  $('#logout').hidden = true;
  $('#signin').hidden = false;
  if (message) say('warn', message);
}

async function boot() {
  const s = await api('/admin/api/session').catch(() => null);
  if (!s) return say('err', 'Could not reach the server. Reload the page.');
  for (const b of document.querySelectorAll('[data-bot]')) b.textContent = `@${s.botUsername ?? 'instapaid.official'}`;
  if (!s.signedIn) return signedOut();
  csrf = s.csrf;
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = `@${s.username}`;
  $('#who').hidden = false;
  $('#logout').hidden = false;
  $('#signed-as').textContent = `Signed in as @${s.username}`;
  for (const b of document.querySelectorAll('[data-bot]')) b.textContent = `@${s.username}`;
  $('#new-text').placeholder = `Write a comment as @${s.username}`;
  await Promise.all([loadPosts(), loadRequests()]);
}

async function loadPosts() {
  const list = $('#posts');
  list.setAttribute('aria-busy', 'true');
  let media;
  try { ({ media } = await api('/admin/api/media')); } catch (e) { list.replaceChildren(el('li', { class: 'empty', text: e.message })); return; }
  finally { list.removeAttribute('aria-busy'); }
  if (!media.length) { list.replaceChildren(el('li', { class: 'empty', text: 'No posts yet.' })); return; }
  list.replaceChildren(...media.map((m) => {
    const pic = m.hasPicture
      ? el('img', { class: 'adm-thumb', src: `/admin/api/media/${m.id}/picture`, alt: '', loading: 'lazy', width: 200, height: 200 })
      : el('span', { class: 'adm-thumb none' }, icon('post'));
    const b = el('button', {
      type: 'button', class: 'adm-pick', 'aria-pressed': 'false', 'data-media': m.id,
      onclick: () => select(m, b),
    }, pic, el('span', { class: 'adm-pick-txt' },
      el('span', { class: 'adm-pick-cap', text: m.caption || 'No caption' }),
      el('span', { class: 'adm-pick-meta', text: `${plural(m.commentsCount, 'comment')} · ${when(m.timestamp)}` })));
    return el('li', {}, b);
  }));
}

async function select(m, button) {
  current = m;
  for (const b of document.querySelectorAll('.adm-pick')) b.setAttribute('aria-pressed', String(b === button));
  const sec = $('#post');
  sec.hidden = false;
  $('#post-caption').textContent = m.caption || 'No caption';
  $('#post-meta').textContent = `${m.mediaType ? m.mediaType.toLowerCase().replace('_', ' ') + ' · ' : ''}${when(m.timestamp)}`;
  const pic = $('#post-pic');
  pic.hidden = !m.hasPicture;
  if (m.hasPicture) pic.src = `/admin/api/media/${m.id}/picture`;
  const link = $('#post-link');
  link.hidden = !m.permalink;
  if (m.permalink) link.href = m.permalink;
  $('#new-text').value = '';
  count();
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sec.focus({ preventScroll: true });
  await loadComments();
}

async function loadComments() {
  const list = $('#comments');
  if (!current) return;
  list.replaceChildren(el('li', { class: 'adm-empty', text: 'Loading comments…' }));
  let comments;
  try { ({ comments } = await api(`/admin/api/media/${current.id}/comments`)); } catch (e) { list.replaceChildren(el('li', { class: 'adm-empty', text: e.message })); return; }
  const n = comments.reduce((a, c) => a + 1 + c.replies.length, 0);
  $('#comments-count').textContent = `(${n})`;
  if (!comments.length) { list.replaceChildren(el('li', { class: 'adm-empty', text: 'No comments on this post yet.' })); return; }
  list.replaceChildren(...comments.map((c) => commentItem(c, true)));
}

function commentItem(c, top) {
  const li = el('li', { class: `adm-c${c.hidden ? ' is-hidden' : ''}`, 'data-comment': c.id });
  const letter = (c.username || '?').replace(/^[._]+/, '').charAt(0).toUpperCase() || '?';
  li.append(
    el('div', { class: 'adm-c-head' },
      el('span', { class: 'ava sm ava-peach', 'aria-hidden': 'true', text: letter }),
      el('b', { text: `@${c.username ?? 'someone'}` }),
      el('time', { datetime: c.timestamp ?? '', text: when(c.timestamp) }),
      c.hidden ? el('span', { class: 'tag', text: 'Hidden' }) : null),
    el('p', { class: 'adm-c-text', text: c.text }),
  );
  const actions = el('div', { class: 'adm-c-actions' });
  const replyForm = top ? replyFormFor(c, li) : null;
  if (top) actions.append(el('button', { type: 'button', class: 'adm-act', text: 'Reply', onclick: () => { replyForm.hidden = false; replyForm.querySelector('textarea').focus(); } }));
  actions.append(
    el('button', { type: 'button', class: 'adm-act', text: c.hidden ? 'Unhide' : 'Hide', onclick: (e) => hide(c, !c.hidden, e.currentTarget) }),
    el('button', { type: 'button', class: 'adm-act danger', text: 'Delete', onclick: () => confirmDelete(c, li, actions) }),
  );
  li.append(actions);
  if (replyForm) li.append(replyForm);
  if (top && c.replies?.length) li.append(el('ul', { class: 'adm-replies', 'aria-label': `Replies to @${c.username ?? 'someone'}` }, ...c.replies.map((r) => commentItem(r, false))));
  return li;
}

function replyFormFor(c, li) {
  const id = `reply-${c.id}`;
  const ta = el('textarea', { id, maxlength: 300, required: true, placeholder: 'Write a reply' });
  const f = el('form', { class: 'adm-form', hidden: true, novalidate: true },
    el('label', { for: id, text: `Reply to @${c.username ?? 'someone'}` }), ta,
    el('div', { class: 'adm-form-row' }, el('span', { class: 'hint', text: 'Posted under the comment, as the account.' }),
      el('span', { class: 'btns' },
        el('button', { type: 'button', class: 'adm-act', text: 'Cancel', onclick: () => { f.hidden = true; ta.value = ''; } }),
        el('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: 'Post reply' }))));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = ta.value.trim();
    if (!message) return say('warn', 'Write a reply first.');
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api(`/admin/api/comments/${c.id}/replies`, { method: 'POST', body: { message } });
      say('ok', c.username ? `Reply posted under @${c.username}'s comment.` : 'Reply posted.');
      await loadComments();
    } catch (err) { say('err', err.message); btn.disabled = false; }
  });
  return f;
}

async function hide(c, hideIt, btn) {
  btn.disabled = true;
  try {
    await api(`/admin/api/comments/${c.id}/hide`, { method: 'POST', body: { hide: hideIt } });
    say('ok', hideIt ? `Comment by @${c.username ?? 'someone'} hidden.` : `Comment by @${c.username ?? 'someone'} shown again.`);
    await loadComments();
  } catch (e) { say('err', e.message); btn.disabled = false; }
}

function confirmDelete(c, li, actions) {
  if (li.querySelector(':scope > .adm-confirm')) return;
  actions.hidden = true;
  const keep = el('button', { type: 'button', class: 'adm-act', text: 'Keep it' });
  const yes = el('button', { type: 'button', class: 'adm-act solid-danger', text: 'Yes, delete' });
  const box = el('div', { class: 'adm-confirm', role: 'group', 'aria-label': 'Confirm delete' },
    el('span', { text: 'Delete this comment for good?' }), yes, keep);
  keep.addEventListener('click', () => { box.remove(); actions.hidden = false; actions.querySelector('.danger').focus(); });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await api(`/admin/api/comments/${c.id}`, { method: 'DELETE' });
      say('ok', `Comment by @${c.username ?? 'someone'} deleted.`);
      await loadComments();
    } catch (e) { say('err', e.message); yes.disabled = false; }
  });
  actions.after(box);
  yes.focus();
}

const STATUS_WORDS = { launched: 'Launched', existing: 'Already had one', skipped: 'Skipped', failed: 'Failed', working: 'Working' };
async function loadRequests() {
  const list = $('#requests');
  let requests;
  try { ({ requests } = await api('/admin/api/requests')); } catch (e) { list.replaceChildren(el('li', { class: 'empty', text: e.message })); return; }
  if (!requests.length) { list.replaceChildren(el('li', { class: 'empty', text: 'No comment launch requests yet.' })); return; }
  list.replaceChildren(...requests.map((r) => el('li', {},
    el('time', { datetime: new Date(r.created_at).toISOString(), text: when(r.created_at) }),
    el('span', { class: `status st ${r.status === 'launched' ? 'claimed' : r.status}`, text: STATUS_WORDS[r.status] ?? r.status }),
    el('span', { class: 'what' },
      el('span', { text: r.username ? `for @${r.username}${r.symbol ? ` · $${r.symbol}` : ''}` : 'post owner unknown' }),
      r.note ? el('span', { class: 'fine', text: r.note }) : null))));
}

function count() { $('#new-count').textContent = `${$('#new-text').value.length} / 300`; }
$('#new-text').addEventListener('input', count);

$('#new-comment').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#new-text').value.trim();
  if (!current) return;
  if (!message) return say('warn', 'Write a comment first.');
  const btn = e.currentTarget.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api(`/admin/api/media/${current.id}/comments`, { method: 'POST', body: { message } });
    $('#new-text').value = '';
    count();
    say('ok', 'Comment posted. It is on Instagram now.');
    await loadComments();
  } catch (err) { say('err', err.message); } finally { btn.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
  signedOut();
  say('ok', 'Logged out.');
});

boot();
