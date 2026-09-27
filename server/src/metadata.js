const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Only Instagram's own image CDN, so the server never fetches an arbitrary URL for a stranger.
export function allowedImageUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (/\.cdninstagram\.com$/.test(url.hostname) || /\.fbcdn\.net$/.test(url.hostname));
  } catch { return false; }
}

export async function loadImage({ imageUrl, imageBase64 }, fetchImpl = fetch) {
  if (imageBase64) {
    const m = String(imageBase64).match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m || !IMAGE_TYPES.has(m[1])) throw new Error('image must be a PNG, JPEG, WebP or GIF');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE) throw new Error('image is over 4 MB');
    return { buf, type: m[1] };
  }
  if (!imageUrl || !allowedImageUrl(imageUrl)) throw new Error('image must be uploaded or come from Instagram');
  const r = await fetchImpl(imageUrl, { redirect: 'error' });
  const type = (r.headers.get('content-type') || '').split(';')[0];
  if (!r.ok || !IMAGE_TYPES.has(type)) throw new Error('could not read the profile picture');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('image is over 4 MB');
  return { buf, type };
}

/** Every coin says whose fees these are and that the account did not make it. */
export function tokenDescription(username, userText, publicUrl) {
  const head = `Creator fees go to Instagram @${username}, claimable only by that account after it verifies at ${publicUrl}/u/${username}. `
    + `Launched by a fan, not by @${username}, unless they say so themselves.`;
  const extra = String(userText || '').trim().slice(0, 400);
  return extra ? `${head}\n\n${extra}` : head;
}

/** Upload image + metadata to pump.fun's IPFS endpoint; returns the metadata URI. */
export async function uploadMetadata(cfg, { name, symbol, description, username, image }, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new Blob([image.buf], { type: image.type }), 'image');
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description);
  form.append('website', `${cfg.publicUrl}/u/${username}`);
  form.append('twitter', '');
  form.append('telegram', '');
  form.append('showName', 'true');
  const r = await fetchImpl(cfg.ipfsUploadUrl, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`metadata upload failed (${r.status})`);
  const j = await r.json();
  if (!j.metadataUri) throw new Error('metadata upload returned no URI');
  return j.metadataUri;
}
