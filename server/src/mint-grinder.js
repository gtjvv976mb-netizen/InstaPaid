// The background search for coin addresses that end in a suffix ("pump", as pump.fun's own coins do).
// Run by src/mintpool.js as a child process at the lowest CPU priority, so the web server always
// comes first. It sends each seed it finds to the parent ({ seed: number[] }) and keeps going; the
// parent kills it when the stock is full, and it exits by itself if the parent goes away.
import { generateKeyPairSync } from 'node:crypto';
import { setPriority } from 'node:os';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const suffix = process.argv[2] ?? '';
if (!suffix || suffix.length > 6 || [...suffix].some((ch) => !ALPHABET.includes(ch))) {
  console.error(`mint-grinder: "${suffix}" is not a base58 suffix of 1–6 characters`);
  process.exit(2);
}
try { setPriority(19); } catch { /* not allowed here: run at normal priority */ }

// A base58 address ends in `suffix` exactly when the key, read as one big number, leaves this
// remainder after division by 58^length. The running remainder fits in a double (58^6 × 256 < 2^53).
const MOD = 58 ** suffix.length;
const WANT = [...suffix].reduce((r, ch) => r * 58 + ALPHABET.indexOf(ch), 0);

process.on('disconnect', () => process.exit(0));

function search() {
  for (let i = 0; i < 20_000; i++) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    let r = 0;
    for (let j = 0; j < 32; j++) r = (r * 256 + pub[j]) % MOD;
    if (r === WANT) process.send?.({ seed: [...Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url')] });
  }
  setImmediate(search); // lets a disconnect or a kill through between batches
}
search();
