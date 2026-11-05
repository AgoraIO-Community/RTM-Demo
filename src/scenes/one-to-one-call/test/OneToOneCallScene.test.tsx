import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppCallRtmSession, CallRtm, type CallRtmClient } from '../rtm';
import { AppCallController } from '../app/call-controller';
import { OneToOneCallScene } from '../OneToOneCallScene';
import type { RtcHandlers, RtcHelper } from '../../../shared/rtc';
import { createOneToOneCallFakes } from './scene.test-helpers';

function setup() {
  sessionStorage.setItem('rtm-lab.one-to-one-call.uid', 'call-local01');
  const listeners = new Map<string, Set<(event: never) => void>>();
  let rtcHandlers: RtcHandlers | undefined;
  const publish = vi.fn(async (
    _targetUid: string,
    _message: string,
    _options: { channelType: 'USER'; customType: string; storeInHistory: false },
  ) => undefined);
  const logout = vi.fn(async () => undefined);
  const client: CallRtmClient = {
    addEventListener(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener as (event: never) => void);
      listeners.set(name, set);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener as (event: never) => void); },
    async login() {
      for (const listener of listeners.get('linkState') ?? []) {
        listener({ currentState: 'CONNECTED', previousState: 'CONNECTING', timestamp: Date.now() } as never);
      }
    }, logout, publish,
  };
  const noop = async () => undefined;
  const rtc: RtcHelper = {
    registerEvents: (handlers) => { rtcHandlers = handlers; }, join: vi.fn(noop), leave: noop, publishMicrophone: noop,
    unpublishMicrophone: noop, setMicrophoneMuted: vi.fn(noop), isMicrophoneCaptureHealthy: () => true,
    publishCamera: noop, unpublishCamera: noop, setCameraMuted: noop, getLocalVideoTrack: () => undefined,
  };
  const createClient = vi.fn(() => client);
  const overrides = {
    createAppRtmSession: (appId: string, uid: string) => new AppCallRtmSession(appId, uid, { createClient }),
    createRtc: () => rtc,
  };
  return {
    overrides, publish, createClient, logout, rtc,
    emitMessage(event: Record<string, unknown>) {
      for (const listener of listeners.get('message') ?? []) listener(event as never);
    },
    emitLinkState(currentState: string, previousState = 'CONNECTED') {
      for (const listener of listeners.get('linkState') ?? []) {
        listener({ currentState, previousState, timestamp: Date.now() } as never);
      }
    },
    remoteJoined(uid: string) { rtcHandlers?.remoteUserJoined?.(uid); },
  };
}

describe('OneToOneCallScene', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('页面空闲 3 秒后拨号不显示 33s，发送中无倒计时，成功后首次显示 30s', async () => {
    vi.useFakeTimers();
    const context = setup();
    let completePublish!: () => void;
    context.publish.mockImplementationOnce(() => new Promise<undefined>((resolve) => { completePublish = () => resolve(undefined); }));
    await act(async () => {
      render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    });
    expect(screen.getByTestId('one-to-one-call-workbench')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.change(screen.getByLabelText('对方呼叫 ID'), { target: { value: 'call-remote02' } });
    fireEvent.click(screen.getByRole('button', { name: '发起呼叫' }));
    expect(screen.getByText('正在发送邀请…')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+s$/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    await act(async () => { completePublish(); });
    expect(screen.getByText('对方正在响铃')).toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.queryByText('33s')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('29s')).toBeInTheDocument();
  });
  it('本地 CONNECTED 时 publish 超时重试耗尽后显示发送超时，不冒充对方离线', async () => {
    vi.useFakeTimers();
    const context = setup();
    context.publish.mockRejectedValue(Object.assign(new Error('publish timeout'), { errorCode: -11026 }));
    await act(async () => {
      render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    });
    fireEvent.change(screen.getByLabelText('对方呼叫 ID'), { target: { value: 'call-remote02' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发起呼叫' })));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(screen.getByRole('heading', { name: '邀请发送超时' })).toBeInTheDocument();
    expect(screen.queryByText('对方不在线')).not.toBeInTheDocument();
    expect(screen.queryByText('正在发送邀请…')).not.toBeInTheDocument();
    expect(context.publish).toHaveBeenCalledTimes(3);
  });

  it('发送中断网后到原发送总截止，重连蒙层显示本地网络异常', async () => {
    vi.useFakeTimers();
    const context = setup();
    let rejectPublish!: (error: Error) => void;
    context.publish.mockRejectedValue(new Error('publish timeout'));
    context.publish.mockReturnValueOnce(new Promise<undefined>((_resolve, reject) => { rejectPublish = reject; }));
    await act(async () => {
      render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    });
    act(() => context.emitLinkState('CONNECTED'));
    fireEvent.change(screen.getByLabelText('对方呼叫 ID'), { target: { value: 'call-remote02' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发起呼叫' })));
    await act(async () => {
      context.emitLinkState('DISCONNECTED');
      rejectPublish(new Error('publish timeout'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByRole('status')).toHaveTextContent('本地网络异常，呼叫失败');
    expect(screen.queryByText('正在发送邀请…')).not.toBeInTheDocument();
    expect(screen.queryByText('对方不在线')).not.toBeInTheDocument();
  });

  it('Strict Mode 重挂 effect 时复用页面级唯一 RTM client', async () => {
    const context = setup();
    render(
      <StrictMode>
        <OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />
      </StrictMode>,
    );

    expect(await screen.findByTestId('one-to-one-call-workbench')).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(context.createClient).toHaveBeenCalledTimes(1);
    expect(context.logout).not.toHaveBeenCalled();
  });

  it('登录后展示稳定呼叫 ID、昵称、目标输入和发起操作', async () => {
    const context = setup();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    expect(await screen.findByTestId('one-to-one-call-workbench')).toBeInTheDocument();
    expect(screen.getByText('call-local01')).toBeInTheDocument();
    expect(screen.getByLabelText('你的昵称（选填）')).toBeInTheDocument();
    expect(screen.getByLabelText('对方呼叫 ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起呼叫' })).toBeDisabled();
    await userEvent.setup().type(screen.getByLabelText('对方呼叫 ID'), 'invalid');
    expect(screen.getByRole('button', { name: '发起呼叫' })).toBeDisabled();
  });

  it('输入对方 ID 后发出 USER INVITE，发送成功即显示对方正在响铃', async () => {
    const user = userEvent.setup();
    const context = setup();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    await user.type(screen.getByLabelText('对方呼叫 ID'), 'call-remote02');
    await user.click(screen.getByRole('button', { name: '发起呼叫' }));
    await waitFor(() => expect(context.publish).toHaveBeenCalled());
    expect(context.publish.mock.calls[0]?.[2]).toMatchObject({ channelType: 'USER', customType: 'CALL_KIT_INVITE' });
    expect(await screen.findByText('对方正在响铃')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消呼叫' })).toBeInTheDocument();
  });

  it('收到合法邀请后显示主叫和接听、拒绝操作', async () => {
    const context = setup();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    const envelope = {
      callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      extra: '{"nickname":"小明"}',
    };
    context.emitMessage({
      channelType: 'USER', channelName: '', topicName: '', messageType: 'STRING',
      customType: 'CALL_KIT_INVITE', publisher: 'call-remote02', message: JSON.stringify(envelope),
    });
    expect(await screen.findByText('小明')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接听' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('邀请返回 -11033 在默认重试耗尽后显示对方不在线并可再次拨号', async () => {
    vi.useFakeTimers();
    const context = setup();
    context.publish.mockRejectedValue(Object.assign(new Error('peer offline'), { errorCode: -11033 }));
    await act(async () => {
      render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    });
    act(() => context.emitLinkState('CONNECTED'));
    fireEvent.change(screen.getByLabelText('对方呼叫 ID'), { target: { value: 'call-remote02' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发起呼叫' })));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));

    expect(screen.getByRole('heading', { name: '对方不在线' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消呼叫' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument();
    expect(context.publish).toHaveBeenCalledTimes(3);
    expect(screen.getByText('IDLE')).toBeInTheDocument();
    expect(screen.getByLabelText('你的昵称（选填）')).toBeEnabled();
    expect(screen.getByRole('button', { name: '发起呼叫' })).toBeEnabled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发起呼叫' })));
    expect(context.publish).toHaveBeenCalledTimes(4);
  });

  it('登录成功后向共享体验路径上报 login 证据', async () => {
    const context = setup();
    const onExperienceProgress = vi.fn();
    render(
      <OneToOneCallScene
        env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }}
        overrides={context.overrides}
        onExperienceProgress={onExperienceProgress}
      />,
    );
    await screen.findByTestId('one-to-one-call-workbench');
    await waitFor(() => expect(onExperienceProgress).toHaveBeenCalledWith({
      scenarioId: 'one-to-one-call', milestones: ['login'],
    }));
  });

  it('接听握手后等待对端 RTC 加入，再允许静音和挂断', async () => {
    const user = userEvent.setup();
    const context = setup();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    const invite = { callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', extra: '' };
    act(() => context.emitMessage({
      channelType: 'USER', channelName: '', topicName: '', messageType: 'STRING',
      customType: 'CALL_KIT_INVITE', publisher: 'call-remote02', message: JSON.stringify(invite),
    }));
    await user.click(await screen.findByRole('button', { name: '接听' }));
    expect(screen.getByText('等待主叫确认接听')).toBeInTheDocument();
    expect(context.rtc.join).not.toHaveBeenCalled();

    const ack = { type: 'ack', callId: invite.callId, extra: '' };
    act(() => context.emitMessage({
      channelType: 'USER', channelName: '', topicName: '', messageType: 'STRING',
      customType: 'CALL_KIT_ACCEPT', publisher: 'call-remote02', message: JSON.stringify(ack),
    }));
    await waitFor(() => expect(context.rtc.join).toHaveBeenCalledOnce());
    act(() => context.remoteJoined('call-remote02'));
    expect(await screen.findByText('音频通话中')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关闭麦克风' }));
    expect(screen.getByRole('button', { name: '打开麦克风' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '挂断' }));
    expect(await screen.findByText('通话已结束')).toBeInTheDocument();
  });

  it('音频尚在建链时也可挂断，不等待 RTC join 完成', async () => {
    const context = setup();
    let finishJoin!: () => void;
    vi.mocked(context.rtc.join).mockImplementationOnce(() => new Promise<void>((resolve) => { finishJoin = resolve; }));
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    fireEvent.change(screen.getByLabelText('对方呼叫 ID'), { target: { value: 'call-remote02' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发起呼叫' })));
    const { callId } = JSON.parse(context.publish.mock.calls[0]![1]) as { callId: string };
    await act(async () => context.emitMessage({
      channelType: 'USER', customType: 'CALL_KIT_ACCEPT', publisher: 'call-remote02',
      message: JSON.stringify({ callId, type: 'accepted', extra: '' }),
    }));
    expect(screen.getByText('正在建立音频连接')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '挂断' }));
    expect(screen.getByRole('heading', { name: '通话已结束' })).toBeInTheDocument();
    await act(async () => finishJoin());
  });

  it('多个来电按条展示并拒绝指定邀请，另一条仍可接听', async () => {
    const context = setup();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    for (const [callId, publisher, nickname] of [
      ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'call-remote02', '小明'],
      ['BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'call-other003', '小红'],
    ]) {
      await act(async () => context.emitMessage({
        channelType: 'USER', customType: 'CALL_KIT_INVITE', publisher,
        message: JSON.stringify({ callId, extra: JSON.stringify({ nickname }) }),
      }));
    }
    const red = screen.getByRole('article', { name: '来自小红的来电' });
    const ming = screen.getByRole('article', { name: '来自小明的来电' });
    await userEvent.setup().click(within(red).getByRole('button', { name: '拒绝' }));
    expect(screen.queryByRole('article', { name: '来自小红的来电' })).not.toBeInTheDocument();
    expect(within(ming).getByRole('button', { name: '接听' })).toBeEnabled();
    expect(context.publish.mock.calls.at(-1)?.[0]).toBe('call-other003');
  });

  it('通用无网络替身可驱动邀请、ACK 和目标 RTC 进出', async () => {
    sessionStorage.setItem('rtm-lab.one-to-one-call.uid', 'call-local01');
    const fakes = createOneToOneCallFakes();
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={fakes.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    const base = { channelType: 'USER', publisher: 'call-remote02' };
    const callId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await act(async () => fakes.emitMessage({ ...base, customType: 'CALL_KIT_INVITE', message: JSON.stringify({ callId, extra: '' }) }));
    await userEvent.setup().click(screen.getByRole('button', { name: '接听' }));
    expect(screen.getByText('等待主叫确认接听')).toBeInTheDocument();
    await act(async () => fakes.emitMessage({ ...base, customType: 'CALL_KIT_ACCEPT', message: JSON.stringify({ callId, type: 'ack', extra: '' }) }));
    act(() => fakes.remoteJoined('call-remote02'));
    expect(screen.getByText('音频通话中')).toBeInTheDocument();
    act(() => fakes.remoteLeft('call-remote02'));
    expect(screen.getByRole('heading', { name: '通话已结束' })).toBeInTheDocument();
  });

  it.each(['focus', 'pageshow', 'visibilitychange', 'reconnect'])('%s 恢复入口立即终结睡眠期间已过期的来电', async (entry) => {
    vi.useFakeTimers();
    const context = setup();
    await act(async () => {
      render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    });
    await act(async () => context.emitMessage({
      channelType: 'USER', customType: 'CALL_KIT_INVITE', publisher: 'call-remote02',
      message: JSON.stringify({ callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', extra: '' }),
    }));
    expect(screen.getByRole('button', { name: '接听' })).toBeInTheDocument();
    vi.setSystemTime(Date.now() + 45_000);
    await act(async () => {
      if (entry === 'reconnect') context.emitLinkState('CONNECTED');
      else if (entry === 'visibilitychange') document.dispatchEvent(new Event(entry));
      else window.dispatchEvent(new Event(entry));
    });
    expect(screen.queryByRole('button', { name: '接听' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '邀请已过期' })).toBeInTheDocument();
  });

  it('RTM 重连时遮罩非通话操作并上报连接状态', async () => {
    const context = setup();
    const onConnectionState = vi.fn();
    render(
      <OneToOneCallScene
        env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }}
        overrides={context.overrides}
        onConnectionState={onConnectionState}
      />,
    );
    await screen.findByTestId('one-to-one-call-workbench');
    act(() => context.emitLinkState('DISCONNECTED'));
    expect(await screen.findByText('RTM 连接中断，正在重连…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发起呼叫' })).toBeDisabled();
    expect(onConnectionState).toHaveBeenLastCalledWith('reconnecting');
  });

  it('SDK 消息与连接事件直接进入场景 RTM，App 只补查媒体截止', async () => {
    const context = setup();
    const messageEntry = vi.spyOn(CallRtm.prototype, 'handleMessage');
    const linkEntry = vi.spyOn(CallRtm.prototype, 'handleLinkStateChange');
    const mediaCheck = vi.spyOn(AppCallController.prototype, 'checkDeadlines');
    render(<OneToOneCallScene env={{ configured: true, appId: 'app-id', source: 'window.__ENV__' }} overrides={context.overrides} />);
    await screen.findByTestId('one-to-one-call-workbench');
    await act(async () => context.emitMessage({
      channelType: 'USER', customType: 'CALL_KIT_INVITE', publisher: 'call-remote02',
      message: JSON.stringify({ callId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', extra: '{"nickname":"小明"}' }),
    }));
    expect(screen.getByRole('heading', { name: '小明' })).toBeInTheDocument();
    expect(messageEntry).toHaveBeenCalledOnce();
    mediaCheck.mockClear();
    act(() => context.emitLinkState('DISCONNECTED'));
    expect(linkEntry).toHaveBeenCalledOnce();
    expect(mediaCheck).toHaveBeenCalledOnce();
  });
});
