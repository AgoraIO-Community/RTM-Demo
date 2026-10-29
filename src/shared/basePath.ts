/** A public base is a local, unambiguous directory path, never a URL. */
export function normalizeBasePath(value: string): string {
  if (value === '/') return '/';
  const segments = value.replace(/\/$/, '').split('/');
  if (segments.shift() !== '' || segments.length === 0
    || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error('应用基路径无效');
  }
  return `/${segments.join('/')}/`;
}
