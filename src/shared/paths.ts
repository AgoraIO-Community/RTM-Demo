import { normalizeBasePath } from './basePath';

export { normalizeBasePath } from './basePath';

/** Keep legacy origin-root URLs usable by the same prefixed build. */
export function getAppBasePath(pathname = window.location.pathname, configuredBase = import.meta.env.BASE_URL): string {
  const base = normalizeBasePath(configuredBase);
  return base !== '/' && (pathname === base.slice(0, -1) || pathname.startsWith(base)) ? base : '/';
}

/** Native links, history writes and API calls do not inherit Router's basename. */
export function appPath(path: string): string {
  return `${getAppBasePath()}${path.replace(/^\//, '')}`;
}
