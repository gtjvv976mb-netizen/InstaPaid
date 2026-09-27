// Instagram usernames: 1–30 of a–z, 0–9, "." and "_"; no leading/trailing dot, no "..".
const RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

// First path segments on instagram.com that are never a profile.
export const NOT_PROFILES = new Set([
  'explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts', 'about', 'legal',
  'developer', 'web', 'emails', 'challenge', 'tv', 'privacy', 'session', 'oauth', 'api',
  'static', 'graphql', 'ar', 'lite', 'download', 'directory', 'topics', 'your_activity', 'threads',
]);

export function normalizeHandle(input) {
  if (typeof input !== 'string') return null;
  const h = input.trim().replace(/^@/, '').toLowerCase();
  return RE.test(h) && !NOT_PROFILES.has(h) ? h : null;
}
