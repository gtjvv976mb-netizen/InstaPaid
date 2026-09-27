// Draw a sample card on this host and serve it, to check the card's fonts where the server really
// runs (Render) before AUTO_POST goes on:
//   npm run sample-card                       # a Japanese, an Arabic and a Latin name
//   npm run sample-card -- "Golden Hour" nat.geo
// It is written to POSTS_DIR under a fixed sample name and served at PUBLIC_URL/posts/<name>.jpg.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { renderCard } from '../src/card.js';

const SAMPLE = 'SampLeCard1111111111111111111111'; // mint-shaped, so /posts/ serves it
const [name, username = 'sample.creator'] = process.argv.slice(2);
const names = name ? [name] : ['東京の夕焼けと富士山', 'غروب الشمس فوق البحر', 'Golden Hour'];
mkdirSync(config.postsDir, { recursive: true });
for (const [i, n] of names.entries()) {
  const file = `${SAMPLE.slice(0, -1)}${i + 1}.jpg`;
  const { jpeg, layout } = await renderCard({ image: null, symbol: 'SAMPLE', name: n, username, publicUrl: config.publicUrl });
  writeFileSync(join(config.postsDir, file), jpeg);
  const drawn = layout.lines.some((l) => l.role === 'name');
  console.log(`${config.publicUrl}/posts/${file}  ${JSON.stringify(n)}${drawn ? '' : '  (name left off: no bundled font has it)'}`);
}
