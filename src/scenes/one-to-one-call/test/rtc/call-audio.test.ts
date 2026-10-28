import { describe, expect, it, vi } from 'vitest';

import type { RtcHandlers, RtcHelper } from '../../../../shared/rtc';
import { createCallAudioSession } from '../../rtc/call-audio';

function setup() {
  let handlers: RtcHandlers | undefined;
  const rtc: RtcHelper = {
    registerEvents(next) { handlers = next; },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    publishMicrophone: vi.fn(async () => undefined),
    unpublishMicrophone: vi.fn(async () => undefined),
    setMicrophoneMuted: vi.fn(async () => undefined),
    isMicrophoneCaptureHealthy: vi.fn(() => true),
    publishCamera: vi.fn(async () => undefined),
    unpublishCamera: vi.fn(async () => undefined),
    setCameraMuted: vi.fn(async () => undefined),
    getLocalVideoTrack: vi.fn(() => undefined),
  };
  const audio = createCallAudioSession(rtc);
  return { rtc, audio, get handlers() { return handlers!; } };
}

const SETTINGS = {
  appId: 'app-id',
  callId: '0123456789ABCDEF0123456789ABCDEF',
  localUid: 'call-local01',
  remoteUid: 'call-remote02',
};

describe('CallAudioSession', () => {
  it('加入派生 RTC 频道后发布麦克风', async () => {
    const context = setup();
    await context.audio.connect(SETTINGS);
    expect(context.rtc.join).toHaveBeenCalledWith({
      appId: 'app-id',
      roomId: 'CALL_KIT_RTC_0123456789ABCDEF0123456789ABCDEF',
      userId: 'call-local01',
    });
    expect(context.rtc.publishMicrophone).toHaveBeenCalledOnce();
    expect(context.audio.getSnapshot()).toMatchObject({ status: 'connected', microphone: 'on' });
  });

  it('加入失败是致命错误，麦克风发布失败则保留已加入会话', async () => {
    const joinFailure = setup();
    vi.mocked(joinFailure.rtc.join).mockRejectedValueOnce(new Error('join failed'));
    await expect(joinFailure.audio.connect(SETTINGS)).rejects.toThrow('join failed');
    expect(joinFailure.audio.getSnapshot()).toMatchObject({ status: 'failed' });

    const microphoneFailure = setup();
    vi.mocked(microphoneFailure.rtc.publishMicrophone).mockRejectedValueOnce(new Error('permission denied'));
    await expect(microphoneFailure.audio.connect(SETTINGS)).resolves.toBeUndefined();
    expect(microphoneFailure.audio.getSnapshot()).toMatchObject({
      status: 'connected', microphone: 'error', error: 'permission denied',
    });
  });

  it('只以目标用户加入频道判断对端连接，不要求发布麦克风', async () => {
    const context = setup();
    await context.audio.connect(SETTINGS);
    context.handlers.remoteUserJoined!('someone-else');
    expect(context.audio.getSnapshot().remoteJoined).toBe(false);
    context.handlers.remoteUserJoined!('call-remote02');
    expect(context.audio.getSnapshot().remoteJoined).toBe(true);
    context.handlers.remoteUserLeft!('call-remote02');
    expect(context.audio.getSnapshot().remoteJoined).toBe(false);
  });

  it('麦克风可静音和失败后重试', async () => {
    const context = setup();
    vi.mocked(context.rtc.publishMicrophone).mockRejectedValueOnce(new Error('permission denied'));
    await context.audio.connect(SETTINGS);
    await context.audio.retryMicrophone();
    await context.audio.setMuted(true);
    expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(2);
    expect(context.rtc.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(context.audio.getSnapshot()).toMatchObject({ microphone: 'muted' });
  });

  it('音频会话结束幂等且不可复用，旧事件不能修改新的独立会话', async () => {
    const context = setup();
    await context.audio.connect(SETTINGS);
    const oldHandlers = context.handlers;
    await context.audio.end();
    await context.audio.end();
    await expect(context.audio.connect(SETTINGS)).rejects.toThrow('音频会话已结束');
    const next = setup();
    await next.audio.connect({ ...SETTINGS, callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    oldHandlers.remoteUserJoined!('call-remote02');
    expect(context.rtc.leave).toHaveBeenCalledTimes(1);
    expect(next.audio.getSnapshot()).toMatchObject({
      callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', remoteJoined: false,
    });
  });
});
