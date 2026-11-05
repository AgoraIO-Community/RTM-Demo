import { useEffect, useRef, useState } from 'react';

import type { ExperienceProgress } from '../../shared/experience/types';
import type { TraceEntry } from '../../shared/timeline/traceStore';
import type { AppCallControllerSnapshot } from './app/call-controller';

interface TraceSource {
  getEntries?(): readonly TraceEntry[];
  getTraces?(): readonly TraceEntry[];
  subscribe?(listener: () => void): () => void;
  subscribeTraces?(listener: () => void): () => void;
}

interface ControllerSource {
  getSnapshot(): AppCallControllerSnapshot;
  subscribe(listener: () => void): () => void;
}

export function milestonesFromCallTrace(entry: TraceEntry): readonly string[] {
  if (entry.errorCode !== undefined || entry.errorMessage !== undefined) return [];
  const summary = entry.summary ?? '';
  if (entry.kind === 'api') {
    if (entry.name === 'rtm.login') return ['login'];
    if (entry.name !== 'rtm.publish' || entry.eventTag !== 'USER') return [];
    if (/\bCALL_KIT_INVITE\b/.test(summary)) return ['invitation'];
    if (/\bCALL_KIT_(?:ACCEPT|REFUSE)\b/.test(summary)) return ['response'];
    return [];
  }
  if (entry.name !== 'message' || entry.eventTag !== 'USER' || !summary.includes('· 已消费：')) return [];
  if (/\bCALL_KIT_INVITE\b/.test(summary)) return ['invitation'];
  if (/\bCALL_KIT_(?:ACCEPT|REFUSE)\b/.test(summary)) return ['response'];
  return [];
}

export function milestonesFromCallSnapshot(snapshot: AppCallControllerSnapshot): readonly string[] {
  const milestones: string[] = [];
  if (snapshot.call.status === 'ACTIVE'
    && snapshot.audio.status === 'connected'
    && snapshot.audio.remoteJoined) milestones.push('audio-connected');
  return milestones;
}

export function useOneToOneCallExperienceProgress(
  traceSource: TraceSource,
  controller?: ControllerSource,
): ExperienceProgress {
  const achieved = useRef(new Set<string>());
  const [progress, setProgress] = useState<ExperienceProgress>({ scenarioId: 'one-to-one-call', milestones: [] });

  useEffect(() => {
    const seen = new WeakSet<TraceEntry>();
    const update = () => {
      const before = achieved.current.size;
      const traces = traceSource.getTraces?.() ?? traceSource.getEntries?.() ?? [];
      for (const entry of traces) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        for (const milestone of milestonesFromCallTrace(entry)) achieved.current.add(milestone);
      }
      if (controller) {
        const snapshot = controller.getSnapshot();
        for (const milestone of milestonesFromCallSnapshot(snapshot)) achieved.current.add(milestone);
        if (snapshot.call.status === 'IDLE' && snapshot.call.result) {
          achieved.current.add('call-ended');
        }
      }
      if (achieved.current.size !== before) {
        setProgress({ scenarioId: 'one-to-one-call', milestones: [...achieved.current] });
      }
    };

    const unsubscribeTrace = traceSource.subscribeTraces?.(update) ?? traceSource.subscribe?.(update) ?? (() => undefined);
    const unsubscribeController = controller?.subscribe(update);
    update();
    return () => {
      unsubscribeTrace();
      unsubscribeController?.();
    };
  }, [controller, traceSource]);

  return progress;
}
