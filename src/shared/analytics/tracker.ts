import type { ExperienceProgress, ExperienceScenario } from '../experience/types';
import { completedExperienceSteps } from '../experience/progress';
import { createSessionStore, HANDOFF_PARAM, HANDOFF_TIMEOUT, IDLE_TIMEOUT, readEntry, SCENES,
  type SessionState, type SceneState, type SceneId, type SceneSwitch } from './session';

export type AnalyticsSite = 'cn' | 'global';
export type AnalyticsEnvironment = 'local' | 'prod';
export type LinkType = 'overview' | 'practice' | 'api' | 'source';
export type EventName = 'lab_enter' | 'scene_switch' | 'task_complete'
  | 'scene_complete' | 'console_click' | 'doc_click';
export type AnalyticsProperties = Record<string, string | number | boolean>;
export interface AnalyticsEvent {
  event: EventName;
  properties: AnalyticsProperties;
  immediate: boolean;
}
export interface AnalyticsTracker {
  enterScene(scenario: ExperienceScenario): void;
  prepareSceneSwitch(from: ExperienceScenario, to: ExperienceScenario): void;
  prepareNavigation(to: ExperienceScenario, href: string, newPage: boolean): string;
  resume(): void;
  flush(): void;
  leave(): void;
  updateProgress(scenario: ExperienceScenario, progress?: ExperienceProgress): void;
  consoleClick(scenario: ExperienceScenario, progress?: ExperienceProgress): void;
  docClick(scenario: ExperienceScenario, linkType: LinkType): void;
}
interface TrackerOptions {
  site: AnalyticsSite;
  environment: AnalyticsEnvironment;
  capture: (event: AnalyticsEvent) => void;
  now?: () => number;
  uuid?: () => string;
  href?: () => string;
  referrer?: () => string;
  storage?: (kind: 'local' | 'session') => Storage;
  replaceHref?: (href: string) => void;
  flush?: () => void;
  locks?: Pick<LockManager, 'request'>;
}

const VISITOR_KEY = 'rtm_lab_visitor_v1';

function ready(scenario: ExperienceScenario): scenario is ExperienceScenario & { id: SceneId } {
  return scenario.status === 'ready' && SCENES.includes(scenario.id as SceneId);
}

export function createAnalyticsTracker(options: TrackerOptions): AnalyticsTracker {
  // Changing environment on the same origin must start independent identities
  // and task deduplication without deleting the other environment's state.
  const visitorKey = `${VISITOR_KEY}:${options.environment}`;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const href = options.href ?? (() => window.location.href);
  const referrer = options.referrer ?? (() => document.referrer);
  const storage = options.storage ?? (kind => kind === 'local' ? window.localStorage : window.sessionStorage);
  const store = createSessionStore({ environment: options.environment, storage, uuid, now });
  const read = (kind: 'local' | 'session', key: string) => {
    try { return storage(kind).getItem(key); } catch { return null; }
  };
  const write = (kind: 'local' | 'session', key: string, value: string) => {
    try { storage(kind).setItem(key, value); } catch { /* Memory state remains usable. */ }
  };
  let visitor: string | undefined;
  let session: SessionState | undefined;
  let current: ExperienceScenario | undefined;
  let initialized = false;
  let left = false;
  const flush = () => { try { options.flush?.(); } catch { /* Cleanup must still run. */ } };
  const referrerHost = () => {
    try { return new URL(referrer()).hostname; } catch { return ''; }
  };

  function emit(event: EventName, scene: SceneId, properties: AnalyticsProperties = {}, immediate = false) {
    if (!session) return;
    session.lastAt = now();
    store.recordActivity(session, session.lastAt);
    store.save(session);
    try {
      options.capture({ event, immediate, properties: {
        ts: now(), site: options.site, environment: options.environment, visitor_id: visitor!, lab_session_id: session.id,
        utm_source: session.source, utm_medium: session.medium, scene,
        ...properties,
      } });
    } catch { /* Analytics must never interrupt the experience. */ }
  }

  function ensureScene(scenario: ExperienceScenario): SceneState | undefined {
    if (!ready(scenario)) return;
    if (!visitor) {
      const saved = read('local', visitorKey);
      visitor = saved && /^v_[a-zA-Z0-9_-]{1,80}$/.test(saved) ? saved : `v_${uuid()}`;
      write('local', visitorKey, visitor);
    }
    const at = now();
    let pending: SceneSwitch | undefined;
    if (!initialized) {
      const url = new URL(href());
      const handoff = store.consume(url, at);
      const incoming = readEntry(url.href);
      const saved = store.readBinding();
      session = handoff?.session ?? saved;
      pending = handoff?.switch ?? store.takeSwitch();
      if (url.searchParams.has(HANDOFF_PARAM)) {
        url.searchParams.delete(HANDOFF_PARAM);
        const replace = options.replaceHref ?? (value => window.history.replaceState(window.history.state, '', value));
        replace(url.href);
      }
      if (!handoff && session && incoming.explicit
        && (session.source !== incoming.source || session.medium !== incoming.medium)) session = undefined;
      initialized = true;
    }
    if (session) session = store.resolve(session);
    if (!session || at - session.lastAt >= IDLE_TIMEOUT || at < session.lastAt) {
      const previous = session;
      if (previous) flush();
      const { source, medium } = readEntry(href());
      session = { id: `s_${uuid()}`, lastAt: at, source, medium, scenes: {} };
      if (previous) store.rotate(previous, session);
      else store.attach(session);
      pending = undefined;
      emit('lab_enter', scenario.id, { landing_scene: scenario.id, referrer: referrerHost() });
    }
    store.attach(session);
    store.sweep(at, flush, session.id);
    const state = store.startScene(session, scenario.id, at);
    session.scenes[scenario.id] = state;
    store.save(session);
    current = scenario;
    if (pending?.to === scenario.id && pending.from !== scenario.id
      && at >= pending.at && at - pending.at < HANDOFF_TIMEOUT) {
      emit('scene_switch', scenario.id, { from_scene: pending.from, to_scene: pending.to });
    }
    return state;
  }

  function safely(action: () => void) {
    if (left) return;
    try { action(); } catch { /* Storage, browser and transport failures are non-fatal. */ }
  }

  return {
    enterScene: scenario => safely(() => { ensureScene(scenario); }),
    prepareSceneSwitch: (from, to) => safely(() => {
      if (!ready(from) || !ready(to) || from.id === to.id) return;
      ensureScene(from);
      store.prepareSwitch({ from: from.id, to: to.id, at: now() });
    }),
    prepareNavigation: (to, destination, newPage) => {
      let result = destination;
      safely(() => {
        if (!current || !ready(current) || !ready(to)) return;
        const url = new URL(destination, href());
        if (url.origin !== new URL(href()).origin) return;
        if (!ensureScene(current) || (!newPage && current.id === to.id)) return;
        const change = current.id !== to.id ? { from: current.id, to: to.id, at: now() } : undefined;
        result = store.handoff(session!, url, now(), change);
      });
      return result;
    },
    resume: () => safely(() => { if (current) ensureScene(current); }),
    flush,
    leave: () => {
      if (left) return;
      flush();
      if (session) store.leave(session);
      left = true;
    },
    updateProgress: (scenario, progress) => {
      const update = () => safely(() => {
        const state = ensureScene(scenario);
        if (!state || !ready(scenario)) return;
        const completed = completedExperienceSteps(scenario, progress);
        for (const step of completed) {
          if (state.tasks.includes(step.id)) continue;
          state.tasks.push(step.id);
          store.saveProgress(session!, scenario.id, state);
          emit('task_complete', scenario.id, { task_id: step.id });
        }
        if (!state.complete && scenario.steps.length > 0 && completed.length === scenario.steps.length) {
          state.complete = true;
          store.saveProgress(session!, scenario.id, state);
          emit('scene_complete', scenario.id, {
            task_total: scenario.steps.length, duration_sec: Math.max(0, Math.floor((now() - state.startedAt) / 1000)),
          });
        }
      });
      const locks = options.locks ?? globalThis.navigator?.locks;
      if (locks && session) {
        void locks.request(`rtm_lab_progress:${options.environment}:${session.id}`, update)
          .catch(() => { /* A failed lock cannot affect the scene. */ });
      } else update();
    },
    consoleClick: (scenario, progress) => safely(() => {
      if (!ensureScene(scenario) || !ready(scenario)) return;
      emit('console_click', scenario.id, {
        tasks_done: completedExperienceSteps(scenario, progress).length, task_total: scenario.steps.length,
      }, true);
    }),
    docClick: (scenario, linkType) => safely(() => {
      if (!ensureScene(scenario) || !ready(scenario)) return;
      if (!['overview', 'practice', 'api', 'source'].includes(linkType)) return;
      emit('doc_click', scenario.id, { link_type: linkType }, true);
    }),
  };
}
