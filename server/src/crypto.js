import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM, bound to the account it belongs to (aad), so a row's key cannot be swapped onto another. */
export function sealSecret(secret, masterHex, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(masterHex, 'hex'), iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function openSecret(sealed, masterHex, aad) {
  const buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(masterHex, 'hex'), buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(buf.subarray(28)), d.final()]));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta signs webhook bodies: X-Hub-Signature-256: sha256=<hex hmac(app secret, raw body)>. */
export function metaSignatureOk(rawBody, header, appSecret) {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const want = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(want, header);
}

/** Compact signed token: base64url(json).base64url(hmac). */
export function signToken(payload, secretHex) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readToken(token, secretHex, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(body).digest('base64url');
  if (!safeEqual(want, mac)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > now ? p : null;
  } catch { return null; }
}

// Verification codes: no look-alikes (0/O, 1/I/L).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[randomInt(ALPHA.length)];
  return `IP-${s}`;
}
export const CODE_RE = /\bIP-[A-HJKMNP-Z2-9]{8}\b/;
