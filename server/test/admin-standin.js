// A stand-in for api.instagram.com (the code exchange) and graph.instagram.com (the owner page's
// calls), on one local port. It keeps posts and comments in memory, so comments made, hidden and
// deleted show up on the next read, and records every call with the token it carried.
import { createServer } from 'node:http';
import { POST_PNG } from './helpers.js';

export const OWNER_TOKEN = 'IGAAowner-token-SECRET-0123456789abcdef';
export const OTHER_TOKEN = 'IGAAother-token-SECRET-0123456789abcdef';
export const BOT_ID = '17841400000000001';

export async function startStandIn({ botToken = 't', version = 'v23.0', port = 0 } = {}) {
  const calls = [];
  let nextId = 18000000000000100n;
  const newId = () => String(nextId++);
  const who = {
    [OWNER_TOKEN]: { user_id: BOT_ID, username: 'instapaid.official' },
    [botToken]: { user_id: BOT_ID, username: 'instapaid.official' },
    [OTHER_TOKEN]: { user_id: '17841499999999999', username: 'somebody.else' },
  };
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, '+0000');
  const posts = [
    { id: '17900000000000001', caption: 'New coin: Sunset Bakery ($BAKE) for @sunset.bakery. Fan-made on pump.fun; the creator can claim its fees at instapaid.fun', media_type: 'IMAGE', timestamp: at(3) },
    { id: '17900000000000002', caption: 'New coin: Trail Dog ($TRAIL) for @trail.dog.club. Only the account can claim its fees.', media_type: 'IMAGE', timestamp: at(28) },
    { id: '17900000000000003', caption: 'How InstaPaid works: comment "@instapaid.official make a token for this creator" under a public post.', media_type: 'CAROUSEL_ALBUM', timestamp: at(60) },
  ];
  const comments = new Map([
    ['17900000000000001', [
      { id: '17850000000000011', text: 'Love this bakery, their croissants are the best in town', username: 'croissant.fan', timestamp: at(2), hidden: false, replies: [
        { id: '17850000000000012', text: 'Thanks! The creator can claim the fees any time.', username: 'instapaid.official', timestamp: at(1.5), hidden: false },
      ] },
      { id: '17850000000000013', text: 'buy my followers cheap, link in bio', username: 'spam.account.99', timestamp: at(1), hidden: false, replies: [] },
    ]],
    ['17900000000000002', [{ id: '17850000000000021', text: 'Good boy!', username: 'hiker.jo', timestamp: at(20), hidden: false, replies: [] }]],
  ]);
  const findComment = (id) => {
    for (const [media, list] of comments) {
      for (const c of list) {
        if (c.id === id) return { media, list, c };
        const r = c.replies.find((x) => x.id === id);
        if (r) return { media, list: c.replies, c: r, parent: c };
      }
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const token = url.searchParams.get('access_token') ?? form.get('access_token');
    const params = Object.fromEntries([...url.searchParams, ...form].filter(([k]) => k !== 'access_token'));
    calls.push({ method: req.method, path: url.pathname, token, params });
    const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const bad = () => send(400, { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } });

    if (url.pathname === '/cdn/p.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(POST_PNG); }
    if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
      const code = form.get('code');
      if (code === 'good') return send(200, { access_token: OWNER_TOKEN, user_id: 111, permissions: 'instagram_business_basic,instagram_business_manage_comments' });
      if (code === 'other') return send(200, { data: [{ access_token: OTHER_TOKEN, user_id: 222, permissions: 'instagram_business_basic' }] });
      return send(400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' });
    }
    const prefix = `/${version}/`;
    if (!url.pathname.startsWith(prefix)) return send(404, { error: { message: 'Unknown path', code: 1 } });
    const path = url.pathname.slice(prefix.length).split('/');
    if (!who[token]) return bad();
    const me = who[token];
    if (path[0] === 'me' && path.length === 1) return send(200, { user_id: me.user_id, username: me.username, id: me.user_id });
    if (path[0] === 'me' && path[1] === 'media') {
      const base = `http://127.0.0.1:${server.address().port}`;
      return send(200, {
        data: posts.map((p) => ({
          ...p, media_url: `${base}/cdn/p.png`, permalink: `https://www.instagram.com/p/${p.id.slice(-6)}/`,
          comments_count: (comments.get(p.id) ?? []).reduce((n, c) => n + 1 + c.replies.length, 0),
        })),
      });
    }
    const id = path[0];
    const post = posts.find((p) => p.id === id);
    if (post && path[1] === 'comments' && req.method === 'GET') {
      // As Graph nests an edge: replies { data: [...] }.
      return send(200, { data: (comments.get(id) ?? []).map((c) => ({ ...c, replies: { data: c.replies } })) });
    }
    if (post && path[1] === 'comments' && req.method === 'POST') {
      const c = { id: newId(), text: form.get('message'), username: me.username, timestamp: at(0), hidden: false, replies: [] };
      comments.set(id, [...(comments.get(id) ?? []), c]);
      return send(200, { id: c.id });
    }
    if (post && path.length === 1) {
      const base = `http://127.0.0.1:${server.address().port}`;
      return send(200, { id, media_type: post.media_type, media_url: `${base}/cdn/p.png` });
    }
    const found = findComment(id);
    if (!found) return send(400, { error: { message: 'Unsupported request - the comment does not exist', code: 100, error_subcode: 33 } });
    if (path[1] === 'replies' && req.method === 'POST') {
      if (found.parent) return send(400, { error: { message: 'Cannot reply to a reply', code: 100 } });
      const r = { id: newId(), text: form.get('message'), username: me.username, timestamp: at(0), hidden: false };
      found.c.replies.push(r);
      return send(200, { id: r.id });
    }
    if (path.length === 1 && req.method === 'POST' && form.has('hide')) { found.c.hidden = form.get('hide') === 'true'; return send(200, { success: true }); }
    if (path.length === 1 && req.method === 'DELETE') { found.list.splice(found.list.indexOf(found.c), 1); return send(200, { success: true }); }
    return send(400, { error: { message: 'Unsupported request', code: 100 } });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, posts, comments, close: () => server.close() };
}
