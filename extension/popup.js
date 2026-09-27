import { serverUrl } from './settings.js';

const base = await serverUrl();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const m = tab?.url?.match(/^https:\/\/www\.instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:$|\?|tagged|reels)/);
const skip = ['explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts'];
if (m && !skip.includes(m[1].toLowerCase())) {
  const u = m[1].toLowerCase();
  document.getElementById('who').textContent = '@' + u;
  document.getElementById('here').textContent = `You're on @${u}'s profile.`;
  const b = document.getElementById('launch');
  b.hidden = false;
  b.onclick = () => chrome.tabs.create({ url: `${base}/launch?u=${encodeURIComponent(u)}` });
}
document.getElementById('claim').onclick = () => chrome.tabs.create({ url: `${base}/claim` });
