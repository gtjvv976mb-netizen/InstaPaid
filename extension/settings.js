// Where the instapaid server lives. Change it on the options page.
export const DEFAULT_SERVER = 'https://instapaid.example';

export async function serverUrl() {
  const { server } = await chrome.storage.sync.get('server');
  return (server || DEFAULT_SERVER).replace(/\/$/, '');
}
