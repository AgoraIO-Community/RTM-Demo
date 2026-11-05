import type { ExperienceScenario } from '../experience/types';
import type { AnalyticsTracker } from './tracker';

/** Observe native navigation without preventing the browser's link behavior. */
export function bindAnalyticsToPage(tracker: AnalyticsTracker | undefined,
  resolveScenario: (pathname: string) => ExperienceScenario | undefined) {
  if (!tracker) return;
  const followLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.altKey || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const to = resolveScenario(url.pathname);
    const from = resolveScenario(window.location.pathname);
    if (!to || to.status !== 'ready' || !from) return;
    const newPage = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey
      || (anchor.target !== '' && anchor.target !== '_self');
    if (newPage) anchor.href = tracker.prepareNavigation(to, url.href, true);
    else tracker.prepareSceneSwitch(from, to);
  };
  const activate = () => tracker.resume();
  const visibility = () => {
    if (document.visibilityState === 'visible') activate();
    else tracker.flush();
  };
  const shown = (event: PageTransitionEvent) => { if (!event.persisted) activate(); };
  const leave = () => {
    tracker.leave();
    document.removeEventListener('click', followLink);
    document.removeEventListener('auxclick', followLink);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', activate);
    window.removeEventListener('pageshow', shown);
    window.removeEventListener('pagehide', leave);
  };
  document.addEventListener('click', followLink);
  document.addEventListener('auxclick', followLink);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', activate);
  window.addEventListener('pageshow', shown);
  window.addEventListener('pagehide', leave);
}
