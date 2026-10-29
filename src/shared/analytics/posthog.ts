import type { CaptureOptions, CaptureResult, PostHogConfig } from 'posthog-js';

import {
  createAnalyticsTracker, type AnalyticsEnvironment, type AnalyticsEvent, type AnalyticsProperties, type AnalyticsSite, type EventName,
} from './tracker';

export interface AnalyticsSettings {
  enabled?: boolean;
  projectToken?: string;
  apiHost?: string;
  site?: AnalyticsSite;
  environment?: AnalyticsEnvironment;
}
export interface AnalyticsConfig {
  projectToken: string;
  apiHost: string;
  site: AnalyticsSite;
  environment: AnalyticsEnvironment;
}
interface BuildTimeSettings {
  VITE_POSTHOG_ENABLED?: string;
  VITE_POSTHOG_PROJECT_TOKEN?: string;
  VITE_POSTHOG_HOST?: string;
  VITE_ANALYTICS_SITE?: string;
  VITE_ANALYTICS_ENVIRONMENT?: string;
  PROD?: boolean;
}

function localHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (['localhost', '::1', '[::1]', '0.0.0.0'].includes(host)
    || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 127 || first === 10 || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31);
}

interface AnalyticsInputs {
  injected?: AnalyticsSettings;
  buildTime?: BuildTimeSettings;
  hostname?: string;
}

export function resolveAnalyticsConfig({ injected, buildTime = {}, hostname = '' }: AnalyticsInputs): AnalyticsConfig | undefined {
  if (injected?.enabled === false
    || (injected?.enabled === undefined && buildTime.VITE_POSTHOG_ENABLED === 'false')) return;
  const projectToken = (injected?.projectToken ?? buildTime.VITE_POSTHOG_PROJECT_TOKEN)?.trim();
  if (!projectToken) return;
  const site = injected?.site ?? buildTime.VITE_ANALYTICS_SITE ?? 'cn';
  if (site !== 'cn' && site !== 'global') return;
  const environment = injected?.environment ?? buildTime.VITE_ANALYTICS_ENVIRONMENT
    ?? (buildTime.PROD && !localHostname(hostname) ? 'prod' : 'local');
  if (environment !== 'local' && environment !== 'prod') return;
  try {
    const host = new URL(injected?.apiHost ?? buildTime.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com');
    if (!['https:', 'http:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) return;
    return { projectToken, apiHost: host.href.replace(/\/$/, ''), site, environment };
  } catch { return; }
}

type Validator = (value: unknown) => boolean;
const oneOf = (...values: readonly string[]): Validator => value => typeof value === 'string' && values.includes(value);
const integer: Validator = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const scene = oneOf('voice-room', 'one-to-one-call');
const hostname: Validator = value => {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 253) return false;
  try { return new URL(`https://${value}`).hostname === value; } catch { return false; }
};
const COMMON_FIELDS: Record<string, Validator> = {
  ts: integer, site: oneOf('cn', 'global'), environment: oneOf('local', 'prod'), scene,
  visitor_id: value => typeof value === 'string' && /^v_[a-zA-Z0-9_-]{1,80}$/.test(value),
  lab_session_id: value => typeof value === 'string' && /^s_[a-zA-Z0-9_-]{1,80}$/.test(value),
  utm_source: oneOf('website', 'console', 'docs', 'direct', 'unknown'),
  utm_medium: oneOf('rtm_hero', 'dev_resources', 'bottom_cta', 'banner', 'demo_list', 'rtm_overview', 'scenario_doc', 'none', 'unknown'),
};
const EVENT_FIELDS: Record<EventName, Record<string, Validator>> = {
  lab_enter: { landing_scene: scene, referrer: hostname },
  scene_switch: { from_scene: scene, to_scene: scene },
  task_complete: {
    task_id: oneOf('connection', 'presence', 'seat', 'interaction', 'state', 'ringing', 'response', 'audio', 'control'),
  },
  scene_complete: { task_total: integer, duration_sec: integer },
  console_click: { tasks_done: integer, task_total: integer },
  doc_click: { link_type: oneOf('overview', 'practice', 'api', 'source') },
};

/** Rebuild the final SDK envelope; automatic and nested properties never pass through. */
export function sanitizePostHogEvent(event: CaptureResult | null, projectToken: string): CaptureResult | null {
  if (!event || !Object.hasOwn(EVENT_FIELDS, event.event)) return null;
  const properties: AnalyticsProperties = {};
  for (const [key, validate] of Object.entries({ ...COMMON_FIELDS, ...EVENT_FIELDS[event.event as EventName] })) {
    const value: unknown = event.properties[key];
    if (!validate(value)) return null;
    properties[key] = value as string | number;
  }
  if (oneOf('desktop', 'mobile', 'tablet')(event.properties.device)) properties.device = event.properties.device;
  return {
    uuid: event.uuid, event: event.event, timestamp: new Date(Number(properties.ts)),
    properties: {
      ...properties, token: projectToken, distinct_id: properties.visitor_id,
      $process_person_profile: false, $geoip_disable: true,
    },
  };
}

interface SdkClient {
  init(token: string, config: Partial<PostHogConfig>): unknown;
  capture(event: string, properties: AnalyticsProperties, options?: CaptureOptions): unknown;
}
type SdkLoader = () => Promise<{ PostHog: new () => SdkClient }>;

/** Only configured pages load PostHog. A bounded queue covers asynchronous chunk loading. */
export function startAnalytics(config?: AnalyticsConfig, load: SdkLoader = () => import('posthog-js/no-external')) {
  if (!config) return;
  const settings = config;
  let client: SdkClient | undefined;
  let loading = false;
  let failed = false;
  let pending: AnalyticsEvent[] = [];

  function send(event: AnalyticsEvent) {
    try {
      client?.capture(event.event, event.properties,
        { send_instantly: true, transport: 'sendBeacon', timestamp: new Date(Number(event.properties.ts)) });
    } catch { /* A transport failure cannot interrupt the scene. */ }
  }

  function flush() {
    // SDK events dispatch immediately. Only its asynchronous import can leave a queue.
    const queued = pending;
    pending = [];
    for (let offset = 0; offset < queued.length; offset += 20) {
      const batch = queued.slice(offset, offset + 20).flatMap(event => {
        const clean = sanitizePostHogEvent({ uuid: crypto.randomUUID(), event: event.event, properties: event.properties }, settings.projectToken);
        return clean ? [clean] : [];
      });
      if (!batch.length) continue;
      try {
        const url = `${settings.apiHost}/i/v0/e/`;
        const body = JSON.stringify({ api_key: settings.projectToken, batch, sent_at: new Date().toISOString() });
        if (!navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) {
          void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
            .catch(() => { /* Delivery is best effort. */ });
        }
      } catch { /* Cleanup cannot depend on transport availability. */ }
    }
  }

  function capture(event: AnalyticsEvent) {
    if (failed) return;
    if (client) { send(event); return; }
    if (pending.length < 100) pending.push(event);
    if (loading) return;
    loading = true;
    void Promise.resolve().then(load).then(module => {
      if (!pending.length) { loading = false; return; }
      const sdk = new module.PostHog();
      sdk.init(settings.projectToken, {
        api_host: settings.apiHost, persistence: 'memory', person_profiles: 'never', request_batching: false,
        bootstrap: { distinctID: String(pending[0]?.properties.visitor_id), isIdentifiedID: false },
        autocapture: false, capture_pageview: false, capture_pageleave: false,
        capture_dead_clicks: false, capture_heatmaps: false, capture_exceptions: false,
        capture_performance: false, rageclick: false, disable_session_recording: true,
        disable_surveys: true, disable_product_tours: true, disable_conversations: true,
        disable_external_dependency_loading: true, advanced_disable_flags: true,
        save_campaign_params: false, save_referrer: false, disableDeviceModel: true,
        before_send: event => sanitizePostHogEvent(event, settings.projectToken),
        on_request_error: () => { /* Do not surface analytics errors in the product. */ },
      });
      client = sdk;
      for (const queued of pending) send(queued);
      pending = [];
    }).catch(() => { failed = true; pending = []; });
  }

  return createAnalyticsTracker({ site: settings.site, environment: settings.environment, capture, flush });
}
