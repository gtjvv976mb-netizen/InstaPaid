import { serverUrl } from './settings.js';

// The content script runs on instagram.com; it asks here for the server's view of an account
// so the request comes from the extension, not from Instagram's page.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'account') {
    (async () => {
      const base = await serverUrl();
      try {
        const r = await fetch(`${base}/api/accounts/${encodeURIComponent(msg.username)}`);
        reply({ ok: r.ok, base, data: r.ok ? await r.json() : null });
      } catch {
        reply({ ok: false, base, data: null });
      }
    })();
    return true; // async reply
  }
  if (msg?.type === 'open') {
    serverUrl().then((base) => chrome.tabs.create({ url: base + msg.path }));
  }
});
