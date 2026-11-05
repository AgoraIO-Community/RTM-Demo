import { useEffect, useRef, useState } from 'react';
import type { ExperienceProgress } from '../../shared/experience/types';
import type { TraceEntry } from '../../shared/timeline/traceStore';
import type { AppRtmSession } from './app-rtm';
import type { SingleRoomClient, SingleRoomView } from './event-driven-single-room-client';

/** Success traces are recorded after the API resolves. Failures never advance the guide. */
export function milestonesFromTrace(entry: TraceEntry): readonly string[] {
  if (entry.errorCode !== undefined || entry.errorMessage !== undefined) return [];
  const summary = entry.summary ?? '';
  if (summary.startsWith('名称目录')) return [];
  if (entry.kind === 'api') {
    if (entry.name === 'rtm.login') return ['login'];
    if (entry.name === 'rtm.subscribe') return ['subscribe'];
    if (entry.name === 'rtm.publish' && entry.eventTag === 'USER' && /(?:^| )seat\.(request|invited|invitation\.accepted)(?: |$)/.test(summary)) return ['seat-signal'];
    if (entry.name === 'rtm.publish' && entry.eventTag === 'MESSAGE' && /(?:^| )(chat\.message|gift\.sent|emoji\.reaction)(?: |$)/.test(summary)) return ['interaction-sent'];
    if (entry.name === 'storage.setChannelMetadata' && summary.startsWith('announcement=')) return ['announcement'];
    if (entry.name === 'storage.setChannelMetadata' && summary.startsWith('forcedMutedUserIds=')) return ['muted'];
    if (entry.name === 'presence.setState' && /(?:^|, )muted=true(?:,|$)/.test(summary)) return ['muted'];
  } else {
    if (entry.name === 'message' && entry.eventTag === 'USER' && /^seat\.(request|invited|invitation\.accepted)(?: |$)/.test(summary)) return ['seat-signal'];
    if (entry.name === 'storage' && entry.eventTag === 'UPDATE' && /(?:^|, )announcement=/.test(summary)) return ['announcement'];
    if (entry.name === 'storage' && entry.eventTag === 'UPDATE' && /(?:^|, )forcedMutedUserIds=/.test(summary)) return ['muted'];
  }
  return [];
}

/** Use consumed business state for remote evidence, never a local echo or a display name. */
export function milestonesFromView(view: SingleRoomView): readonly string[] {
  const milestones: string[] = [];
  if (view.onlineUsers.some((uid) => uid !== view.userId)) milestones.push('remote-member');
  if (Object.values(view.snapshot.seats).some((seat) => seat.userId && seat.userId !== view.snapshot.hostUserId)) milestones.push('seat-occupied');
  if (view.interactions.some((item) => ['chat', 'gift', 'emoji'].includes(item.type) && item.senderId !== view.userId)) milestones.push('interaction-received');
  if (Object.entries(view.memberMuted).some(([uid, muted]) => uid !== view.userId && muted)) milestones.push('muted');
  if (view.snapshot.forcedMutedUserIds.some(uid => uid !== view.userId)) milestones.push('muted');
  return milestones;
}

/** Evidence survives trace clearing and room changes for this scene visit. No polling or SDK writes. */
export function useVoiceRoomExperienceProgress(
  session: Pick<AppRtmSession, 'getTraces' | 'subscribeTraces'>,
  client?: Pick<SingleRoomClient, 'getTraces' | 'subscribeTraces' | 'getView' | 'subscribe'>,
  roomReady = true,
): ExperienceProgress {
  const achieved = useRef(new Set<string>());
  const [progress, setProgress] = useState<ExperienceProgress>({ scenarioId: 'voice-room', milestones: [] });
  useEffect(() => {
    const seen = new WeakSet<TraceEntry>();
    const update = () => {
      const before = achieved.current.size;
      for (const entry of [...session.getTraces(), ...(client?.getTraces() ?? [])]) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        for (const id of milestonesFromTrace(entry)) if (id !== 'subscribe' || roomReady) achieved.current.add(id);
      }
      if (client) for (const id of milestonesFromView(client.getView())) achieved.current.add(id);
      if (client) {
        const role = client.getView().role;
        const stateComplete = role === 'host'
          ? achieved.current.has('announcement') && achieved.current.has('muted')
          : achieved.current.has('announcement') || achieved.current.has('muted');
        if (stateComplete) achieved.current.add('state-synced');
      }
      if (achieved.current.size !== before) setProgress({ scenarioId: 'voice-room', milestones: [...achieved.current] });
    };
    const unsubscribe = [session.subscribeTraces(update), client?.subscribeTraces(update), client?.subscribe(update)];
    update();
    return () => unsubscribe.forEach((off) => off?.());
  }, [session, client, roomReady]);
  return progress;
}
