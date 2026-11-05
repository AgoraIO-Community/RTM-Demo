import type { AnalyticsEnvironment } from './tracker';

export const IDLE_TIMEOUT = 24 * 60 * 60 * 1000;
export const HANDOFF_TIMEOUT = 60 * 1000;
export const HANDOFF_PARAM = '__rtm_lab';
export const SCENES = ['voice-room', 'one-to-one-call'] as const;
export type SceneId = typeof SCENES[number];
export interface SceneState { startedAt: number; tasks: string[]; complete: boolean }
export interface SessionState {
  id: string; lastAt: number; source: string; medium: string;
  scenes: Partial<Record<SceneId, SceneState>>;
  nextId?: string;
}
export interface SceneSwitch { from: SceneId; to: SceneId; at: number }
interface Binding { session: SessionState; documentId: string }
interface Handoff { session: SessionState; at: number; path: string; switch?: SceneSwitch }

const ENTRIES: Record<string, readonly string[]> = {
  website: ['rtm_hero', 'dev_resources', 'bottom_cta'],
  console: ['banner'], docs: ['demo_list', 'rtm_overview', 'scenario_doc'],
};
const id = (value: unknown, prefix: string) => typeof value === 'string'
  && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,80}$`).test(value);
const sceneId = (value: unknown): value is SceneId => SCENES.includes(value as SceneId);

export function readEntry(href: string) {
  const params = new URL(href).searchParams;
  const source = params.get('utm_source');
  const medium = params.get('utm_medium');
  const explicit = params.has('utm_source') || params.has('utm_medium');
  if (!explicit) return { source: 'direct', medium: 'none', explicit };
  if (source && medium && Object.hasOwn(ENTRIES, source) && ENTRIES[source].includes(medium)) {
    return { source, medium, explicit };
  }
  return { source: 'unknown', medium: 'unknown', explicit };
}

function validSession(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as SessionState;
  if (!id(state.id, 's') || !Number.isFinite(state.lastAt) || !state.scenes
    || typeof state.scenes !== 'object' || Array.isArray(state.scenes)
    || (state.nextId !== undefined && !id(state.nextId, 's'))) return false;
  if (!((state.source === 'direct' && state.medium === 'none')
    || (state.source === 'unknown' && state.medium === 'unknown')
    || (Object.hasOwn(ENTRIES, state.source) && ENTRIES[state.source].includes(state.medium)))) return false;
  return Object.entries(state.scenes).every(([name, scene]) => sceneId(name) && scene
    && Number.isFinite(scene.startedAt) && Array.isArray(scene.tasks)
    && scene.tasks.every(task => typeof task === 'string') && typeof scene.complete === 'boolean');
}

export function createSessionStore(options: {
  environment: AnalyticsEnvironment;
  storage: (kind: 'local' | 'session') => Storage;
  uuid: () => string;
  now: () => number;
}) {
  const prefix = `rtm_lab_session_v2:${options.environment}:`;
  const members = `rtm_lab_member_v2:${options.environment}:`;
  const transfers = `rtm_lab_handoff_v2:${options.environment}:`;
  const starts = `rtm_lab_scene_v2:${options.environment}:`;
  const progress = `rtm_lab_progress_v2:${options.environment}:`;
  const activity = `rtm_lab_activity_v2:${options.environment}:`;
  const bindingKey = `rtm_lab_binding_v2:${options.environment}`;
  const switchKey = `rtm_lab_switch_v2:${options.environment}`;
  const fallback = { local: new Map<string, string>(), session: new Map<string, string>() };
  const dirty = { local: new Set<string>(), session: new Set<string>() };
  let documentId: string | undefined;
  let consumedHandoff: string | undefined;
  const get = (kind: 'local' | 'session', key: string) => {
    if (dirty[kind].has(key)) return fallback[kind].get(key) ?? null;
    try {
      const value = options.storage(kind).getItem(key);
      if (value !== null) fallback[kind].set(key, value);
      else fallback[kind].delete(key);
      return value;
    } catch { return fallback[kind].get(key) ?? null; }
  };
  const set = (kind: 'local' | 'session', key: string, value: unknown) => {
    const raw = JSON.stringify(value);
    fallback[kind].set(key, raw);
    try { options.storage(kind).setItem(key, raw); dirty[kind].delete(key); }
    catch { dirty[kind].add(key); }
  };
  const remove = (kind: 'local' | 'session', key: string) => {
    fallback[kind].delete(key);
    try { options.storage(kind).removeItem(key); dirty[kind].delete(key); }
    catch { dirty[kind].add(key); }
  };
  const keys = () => {
    try {
      const storage = options.storage('local');
      const stored = Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter(Boolean);
      return [...new Set([...stored, ...dirty.local])]
        .filter(key => !dirty.local.has(key) || fallback.local.has(key));
    } catch { return [...fallback.local.keys()]; }
  };
  const parse = (kind: 'local' | 'session', key: string): unknown => {
    try { return JSON.parse(get(kind, key) ?? 'null'); } catch { return null; }
  };
  const read = (sessionId: string) => {
    const value = parse('local', `${prefix}${sessionId}`);
    if (!validSession(value) || value.id !== sessionId) return;
    for (const name of SCENES) {
      const startedAt = parse('local', `${starts}${sessionId}:${name}`);
      const completed = parse('local', `${progress}${sessionId}:${name}`) as SceneState | null;
      if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
        value.scenes[name] = { startedAt, tasks: [], complete: false };
      }
      if (completed && Number.isFinite(completed.startedAt) && Array.isArray(completed.tasks)
        && completed.tasks.every(task => typeof task === 'string') && typeof completed.complete === 'boolean') {
        value.scenes[name] = { ...completed, startedAt: value.scenes[name]?.startedAt ?? completed.startedAt };
      }
    }
    for (const key of keys()) {
      if (!key.startsWith(`${activity}${sessionId}:`)) continue;
      const at = parse('local', key);
      if (typeof at === 'number' && Number.isFinite(at)) value.lastAt = Math.max(value.lastAt, at);
    }
    return value;
  };
  const resolve = (session: SessionState): SessionState => {
    const seen = new Set<string>();
    let current = read(session.id) ?? session;
    while (current.nextId && !seen.has(current.id)) {
      seen.add(current.id);
      const next = read(current.nextId);
      if (!next) break;
      current = next;
    }
    return current;
  };
  const bound = (): Binding | undefined => {
    const value = parse('session', bindingKey) as Binding | null;
    return value && validSession(value.session) && id(value.documentId, 'd') ? value : undefined;
  };
  const hasMembers = (target: SessionState) => keys().some(key => {
    if (!key.startsWith(members)) return false;
    const sid = parse('local', key);
    if (typeof sid !== 'string') return false;
    const memberSession = read(sid);
    return sid === target.id || (memberSession && resolve(memberSession).id === target.id);
  });
  const hasHandoff = (target: SessionState, at = options.now()) => keys().some(key => {
    if (!key.startsWith(transfers)) return false;
    const value = parse('local', key) as Handoff | null;
    return value && validSession(value.session) && at >= value.at && at - value.at < HANDOFF_TIMEOUT
      && resolve(value.session).id === target.id;
  });
  const cleanGroup = (session: SessionState) => {
    const target = resolve(session);
    const group = keys().filter(key => key.startsWith(prefix)).flatMap(key => {
      const value = parse('local', key);
      return validSession(value) && resolve(value).id === target.id ? [value.id] : [];
    });
    for (const sid of group) remove('local', `${prefix}${sid}`);
    for (const key of keys()) {
      if (key.startsWith(members) && group.includes(parse('local', key) as string)) remove('local', key);
      if ([starts, progress, activity].some(base => group.some(sid => key.startsWith(`${base}${sid}:`)))) remove('local', key);
    }
  };
  const save = (session: SessionState) => {
    set('local', `${prefix}${session.id}`, session);
    if (documentId) set('session', bindingKey, { session, documentId });
  };
  const release = (session: SessionState) => {
    if (documentId) remove('local', `${members}${documentId}`);
    const latest = resolve(session);
    if (!hasMembers(latest) && !hasHandoff(latest)) cleanGroup(latest);
  };

  return {
    readBinding: () => bound()?.session,
    resolve,
    save,
    recordActivity(session: SessionState, at: number) {
      if (documentId) set('local', `${activity}${session.id}:${documentId}`, at);
    },
    startScene(session: SessionState, name: SceneId, at: number): SceneState {
      const key = `${starts}${session.id}:${name}`;
      const saved = parse('local', key);
      if (typeof saved !== 'number' || !Number.isFinite(saved)) {
        set('local', key, session.scenes[name]?.startedAt ?? at);
      }
      return (read(session.id) ?? session).scenes[name] ?? { startedAt: at, tasks: [], complete: false };
    },
    saveProgress(session: SessionState, name: SceneId, state: SceneState) {
      // Only the progress critical section writes this key. Metadata refreshes cannot erase it.
      set('local', `${progress}${session.id}:${name}`, state);
    },
    attach(session: SessionState) {
      const oldBinding = bound();
      documentId ??= `d_${options.uuid()}`;
      if (oldBinding && oldBinding.session.id !== session.id) {
        const previous = resolve(oldBinding.session);
        if (!hasMembers(previous) && !hasHandoff(previous)) cleanGroup(previous);
      }
      if (!read(session.id)) {
        // Restore a closed document's snapshot on an ordinary reload.
        for (const [name, state] of Object.entries(session.scenes)) {
          set('local', `${starts}${session.id}:${name}`, state.startedAt);
          set('local', `${progress}${session.id}:${name}`, state);
        }
      }
      set('local', `${members}${documentId}`, session.id);
      save(session);
      if (consumedHandoff) {
        remove('local', consumedHandoff);
        consumedHandoff = undefined;
      }
    },
    leave(session: SessionState) {
      const latest = resolve(session);
      save(latest);
      release(session);
    },
    rotate(previous: SessionState, next: SessionState) {
      save(next);
      set('local', `${prefix}${previous.id}`, { ...previous, nextId: next.id });
      this.attach(next);
      if (!hasMembers(previous)) remove('local', `${prefix}${previous.id}`);
    },
    prepareSwitch(value: SceneSwitch) { set('session', switchKey, value); },
    takeSwitch(): SceneSwitch | undefined {
      const value = parse('session', switchKey) as SceneSwitch | null;
      remove('session', switchKey);
      return value && sceneId(value.from) && sceneId(value.to) && Number.isFinite(value.at) ? value : undefined;
    },
    handoff(session: SessionState, url: URL, at: number, change?: SceneSwitch) {
      const token = options.uuid();
      set('local', `${transfers}${token}`, { session, at, path: url.pathname, switch: change });
      url.searchParams.set(HANDOFF_PARAM, token);
      return url.href;
    },
    consume(url: URL, at: number): Handoff | undefined {
      const token = url.searchParams.get(HANDOFF_PARAM);
      if (!token || !/^[a-zA-Z0-9_-]{1,80}$/.test(token)) return;
      const key = `${transfers}${token}`;
      const value = parse('local', key) as Handoff | null;
      if (!value || !validSession(value.session) || value.path !== url.pathname
        || !Number.isFinite(value.at) || at < value.at || at - value.at >= HANDOFF_TIMEOUT) {
        remove('local', key);
        return;
      }
      // Keep the reservation until attach has registered the destination document.
      consumedHandoff = key;
      return value;
    },
    sweep(at: number, flush: () => void, activeId?: string) {
      for (const key of keys()) {
        if (key.startsWith(transfers)) {
          const value = parse('local', key) as Handoff | null;
          if (!value || !Number.isFinite(value.at) || at < value.at || at - value.at >= HANDOFF_TIMEOUT) remove('local', key);
        }
        if (!key.startsWith(prefix)) continue;
        const value = parse('local', key);
        if (!validSession(value)) { remove('local', key); continue; }
        const latest = resolve(value);
        if (latest.id !== activeId && (at < latest.lastAt || at - latest.lastAt >= IDLE_TIMEOUT
          || (!hasMembers(latest) && !hasHandoff(latest, at)))) {
          flush();
          cleanGroup(latest);
        }
      }
    },
  };
}
