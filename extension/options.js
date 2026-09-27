import { serverUrl } from './settings.js';

const input = document.getElementById('server');
input.value = await serverUrl();
document.getElementById('save').onclick = async () => {
  let url;
  try { url = new URL(input.value.trim()); } catch { document.getElementById('msg').textContent = 'That is not a web address.'; return; }
  const origin = url.origin;
  // The server needs host permission so the background worker can read account totals.
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  await chrome.storage.sync.set({ server: origin });
  document.getElementById('msg').textContent = granted ? 'Saved.' : 'Saved, but without permission the profile totals will not load.';
};
