const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Only Instagram's own image CDN, so the server never fetches an arbitrary URL for a stranger.
export function allowedImageUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (/\.cdninstagram\.com$/.test(url.hostname) || /\.fbcdn\.net$/.test(url.hostname));
  } catch { return false; }
}

/**
 * What an image really is, from its first bytes: PNG, JPEG, GIF or WebP, else null. SVG, HEIC,
 * TIFF, PDF and anything else are null, so only these four ever reach sharp, pump.fun or Claude.
 */
export function sniffImage(buf) {
  const b = buf ? Buffer.from(buf) : Buffer.alloc(0);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * The coin's picture. An upload must be what it says it is (a PNG sent as a PNG); a picture from
 * Instagram's CDN is taken as whatever its bytes are, as long as that is one of the four types.
 */
export async function loadImage({ imageUrl, imageBase64 }, fetchImpl = fetch) {
  if (imageBase64) {
    const m = String(imageBase64).match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m || !IMAGE_TYPES.has(m[1])) throw new Error('image must be a PNG, JPEG, WebP or GIF');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE) throw new Error('image is over 4 MB');
    if (sniffImage(buf) !== m[1]) throw new Error('image is not the PNG, JPEG, WebP or GIF it says it is');
    return { buf, type: m[1] };
  }
  if (!imageUrl || !allowedImageUrl(imageUrl)) throw new Error('image must be uploaded or come from Instagram');
  const r = await fetchImpl(imageUrl, { redirect: 'error' });
  const type = (r.headers.get('content-type') || '').split(';')[0];
  if (!r.ok || !IMAGE_TYPES.has(type)) throw new Error('could not read the profile picture');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('image is over 4 MB');
  const real = sniffImage(buf);
  if (!real) throw new Error('could not read the profile picture');
  return { buf, type: real };
}

/** Every coin says whose fees these are and that the account did not make it. */
export function tokenDescription(username, userText, publicUrl) {
  const head = `Creator fees go to Instagram @${username}, claimable only by that account after it verifies at ${publicUrl}/u/${username}. `
    + `Launched by a fan, not by @${username}, unless they say so themselves.`;
  const extra = String(userText || '').trim().slice(0, 400);
  return extra ? `${head}\n\n${extra}` : head;
}

/**
 * Upload image + metadata to pump.fun's IPFS endpoint; returns the metadata URI.
 * `website` defaults to the creator's Instagram profile; comment launches pass the Instagram post's link.
 * (pump.fun has no Instagram field: its website button is where people look for the creator.)
 */
/** The creator's Instagram profile, the coin's link when it has no post. */
export const instagramProfile = (username) => `https://www.instagram.com/${encodeURIComponent(username)}/`;

export async function uploadMetadata(cfg, { name, symbol, description, username, image, website }, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new Blob([image.buf], { type: image.type }), 'image');
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description ?? '');
  form.append('website', website || instagramProfile(username));
  form.append('twitter', '');
  form.append('telegram', '');
  form.append('showName', 'true');
  const r = await fetchImpl(cfg.ipfsUploadUrl, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`metadata upload failed (${r.status})`);
  const j = await r.json();
  if (!j.metadataUri) throw new Error('metadata upload returned no URI');
  return j.metadataUri;
}
