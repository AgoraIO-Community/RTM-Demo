import { act, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { createTraceStore, type TraceEntry } from '../../../shared/timeline/traceStore';
import type { AppCallControllerSnapshot } from '../app/call-controller';
import { experienceForPath } from '../../../app/experienceScenarios';
import { ExperiencePath } from '../../../shared/experience/ExperiencePath';
import {
  milestonesFromCallSnapshot,
  milestonesFromCallTrace,
  useOneToOneCallExperienceProgress,
} from '../experienceProgress';

function trace(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return { uid: 'call-local01', role: 'caller', seq: 1, at: 1, kind: 'api', name: 'rtm.login', ...overrides };
}

function snapshot(overrides: Partial<AppCallControllerSnapshot> = {}): AppCallControllerSnapshot {
  return {
    call: { status: 'IDLE' },
    audio: { status: 'idle', remoteJoined: false, microphone: 'off' },
    incomingInvitations: [], canAcceptIncoming: true,
    ...overrides,
  };
}

describe('1V1 呼叫邀请体验证据', () => {
  it.each(['CALL_KIT_CANCEL', 'CALL_KIT_BUSY', 'CALL_KIT_END'])('%s 不完成响应邀请任务', (signal) => {
    expect(milestonesFromCallTrace(trace({ name: 'rtm.publish', eventTag: 'USER', summary: `to remote ${signal}` })))
      .toEqual([]);
    expect(milestonesFromCallTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: `from remote ${signal} · 已消费：结束当前呼叫` })))
      .toEqual([]);
  });

  it.each(['CALL_KIT_ACCEPT', 'CALL_KIT_REFUSE'])('%s 有效收发才完成响应邀请任务', (signal) => {
    expect(milestonesFromCallTrace(trace({ name: 'rtm.publish', eventTag: 'USER', summary: `to remote ${signal}` })))
      .toEqual(['response']);
    expect(milestonesFromCallTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: `from remote ${signal} · 已消费：处理被叫响应` })))
      .toEqual(['response']);
    expect(milestonesFromCallTrace(trace({ name: 'rtm.publish', eventTag: 'USER', summary: `to remote ${signal}`, errorMessage: '发送失败' })))
      .toEqual([]);
    expect(milestonesFromCallTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: `from remote ${signal} · 已忽略：信令已过期` })))
      .toEqual([]);
  });

  it.each([
    {
      role: '主叫成功发送邀请',
      invitation: { kind: 'api', name: 'rtm.publish', summary: 'to remote CALL_KIT_INVITE' },
      completed: true,
    },
    {
      role: '被叫消费有效邀请',
      invitation: { kind: 'event', name: 'message', summary: 'from remote CALL_KIT_INVITE · 已消费：收到呼叫邀请' },
      completed: true,
    },
    {
      role: '被叫忽略过期邀请',
      invitation: { kind: 'event', name: 'message', summary: 'from remote CALL_KIT_INVITE · 已忽略：信令已过期' },
      completed: false,
    },
    {
      role: '主叫发送邀请失败',
      invitation: { kind: 'api', name: 'rtm.publish', summary: 'to remote CALL_KIT_INVITE', errorMessage: '发送失败' },
      completed: false,
    },
  ] as const)('$role时正确显示首项任务进度', ({ invitation, completed }) => {
    const traces = createTraceStore({ uid: 'call-local01', role: 'caller' });
    function ProgressPath() {
      const progress = useOneToOneCallExperienceProgress(traces);
      return createElement(ExperiencePath, {
        scenario: experienceForPath('/social/one-to-one-call'), progress,
        collapsed: false, onToggle: () => undefined,
      });
    }
    render(createElement(ProgressPath));
    act(() => traces.record({ at: 1, eventTag: 'USER', ...invitation }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', completed ? '1' : '0');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '4');
  });

  it('只用成功的 RTM API 和已消费 USER EVENT 推进信令步骤', () => {
    expect(milestonesFromCallTrace(trace())).toEqual(['login']);
    expect(milestonesFromCallTrace(trace({ errorMessage: '登录失败' }))).toEqual([]);
    expect(milestonesFromCallTrace(trace({ name: 'rtm.publish', eventTag: 'USER', summary: 'to remote CALL_KIT_INVITE' })))
      .toEqual(['invitation']);
    expect(milestonesFromCallTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: 'from remote CALL_KIT_ACCEPT · 已消费：确认对方接听' })))
      .toEqual(['response']);
    expect(milestonesFromCallTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: 'from remote CALL_KIT_ACCEPT · 已忽略：与当前呼叫不匹配' })))
      .toEqual([]);
  });

  it('真实双端 RTC active 才完成音频，麦克风状态不单独推进体验进度', () => {
    const active = snapshot({
      call: {
        status: 'ACTIVE', startedAt: 1,
        call: { callId: 'A'.repeat(32), localUid: 'local', remoteUid: 'remote', remoteNickname: '', expiresAt: 30_000 },
      },
      audio: { status: 'connected', callId: 'A'.repeat(32), remoteJoined: true, microphone: 'on' },
    });
    expect(milestonesFromCallSnapshot(active)).toEqual(['audio-connected']);
    expect(milestonesFromCallSnapshot({ ...active, audio: { ...active.audio, microphone: 'muted' } }))
      .toEqual(['audio-connected']);
    expect(milestonesFromCallSnapshot(snapshot())).toEqual([]);
  });

  it('响应订阅并累积控制证据，清空 trace 不倒退，重新挂载才重置', () => {
    const traces = createTraceStore({ uid: 'call-local01', role: 'caller' });
    let current = snapshot();
    const listeners = new Set<() => void>();
    const controller = {
      getSnapshot: () => current,
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const { result, unmount } = renderHook(() => useOneToOneCallExperienceProgress(traces, controller));

    act(() => traces.record({ at: 1, kind: 'api', name: 'rtm.login' }));
    act(() => {
      current = snapshot({ audio: { status: 'connected', remoteJoined: true, microphone: 'muted' } });
      listeners.forEach((listener) => listener());
    });
    act(() => {
      current = snapshot({
        call: {
          status: 'IDLE',
          result: {
            reason: 'ENDED',
            call: { callId: 'A'.repeat(32), localUid: 'local', remoteUid: 'remote', remoteNickname: '', expiresAt: 30_000 },
          },
        },
      });
      listeners.forEach((listener) => listener());
    });
    expect(result.current.milestones).toEqual(['login', 'call-ended']);

    act(() => traces.clear());
    expect(result.current.milestones).toContain('login');
    unmount();
    const next = renderHook(() => useOneToOneCallExperienceProgress(traces, controller));
    expect(next.result.current.milestones).toEqual(['call-ended']);
  });
});
