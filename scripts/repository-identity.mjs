/** Normalize a repository URL or SSH shorthand to host/owner/repository. */
export function normalizeRepositoryIdentity(value) {
  if (typeof value !== 'string') return undefined;
  let source = value.trim();
  if (source.length === 0) return undefined;
  const scp = source.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  const bare = source.match(/^([^/:\s]+)\/(.+)$/);
  let host;
  let path;
  if (scp !== null) {
    host = scp[1];
    path = scp[2];
  } else if (bare !== null && !source.includes('://')) {
    host = bare[1];
    path = bare[2];
  } else {
    source = source.replace(/^git\+/i, '');
    let parsed;
    try { parsed = new URL(source); } catch { return undefined; }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
  }
  if (typeof host !== 'string' || typeof path !== 'string') return undefined;
  path = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (path.length === 0 || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}
