import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Copy, Mic, MicOff, Phone, PhoneOff, RotateCcw, WifiOff } from 'lucide-react';

import type { ResolvedEnv } from '../../app/env';
import { useSceneSessionLifecycle } from '../../app/sceneSessions';
import type { ExperienceProgress } from '../../shared/experience/types';
import { createRtcHelper, type RtcHelper } from '../../shared/rtc';
import { getAgoraToken, type TokenProvider } from '../../shared/utils/token';
import { toTraceSource, type TraceSource } from '../../shared/timeline/useMergedTraces';
import { AppCallRtmSession, CallRtm, CalleeInvitationState, type CallRtmLinkState } from './rtm';
import { createCallAudioSession } from './rtc/call-audio';
import { AppCallController } from './app/call-controller';
import { getOrCreateCallIdentity, isValidCallUid, normalizeCallNickname } from './app/identity';
import { useOneToOneCallExperienceProgress } from './experienceProgress';

export interface OneToOneCallOverrides {
  createAppRtmSession?: (appId: string, userId: string) => AppCallRtmSession;
  createRtc?: () => RtcHelper;
}

export interface OneToOneCallSceneProps {
  env: ResolvedEnv;
  overrides?: OneToOneCallOverrides;
  onTraceSources?: (sources: readonly TraceSource[]) => void;
  onExperienceProgress?: (progress: ExperienceProgress | undefined) => void;
  onConnectionState?: (state: CallRtmLinkState | undefined) => void;
}

const RESULT_LABELS: Record<string, string> = {
  REFUSED: '对方已拒绝', CANCELED: '呼叫已取消',
  INVITATION_EXPIRE: '邀请已过期', PEER_OFFLINE: '对方不在线',
  LOCAL_NETWORK_ERROR: '本地网络异常，呼叫失败',
  SEND_TIMEOUT: '邀请发送超时', PUBLISH_TIMEOUT: '邀请发送超时', PUBLISH_FAILED: '邀请发送失败',
  ACCEPT_ACK_TIMEOUT: '接听确认超时', STOPPED: '邀请已停止',
  PEER_NO_RESPONSE: '对方无应答', MEDIA_FAILED: '音频连接失败',
  MEDIA_TIMEOUT: '音频连接超时', ENDED: '通话已结束',
} as const;

export function OneToOneCallScene({
  env, overrides, onTraceSources, onExperienceProgress, onConnectionState,
}: OneToOneCallSceneProps) {
  const identity = useMemo(() => getOrCreateCallIdentity(sessionStorage), []);
  const auth = env.configured ? env.auth : undefined;
  const getToken = useMemo<TokenProvider | undefined>(() => auth
    ? request => getAgoraToken(request, auth) : undefined, [auth]);
  const session = useMemo(
    () => overrides?.createAppRtmSession?.(env.configured ? env.appId : '', identity.uid)
      ?? new AppCallRtmSession(env.configured ? env.appId : '', identity.uid, { getToken }),
    [env, identity.uid, overrides, getToken],
  );
  const controllerRef = useRef<AppCallController | undefined>(undefined);
  const rtmRef = useRef<CallRtm | undefined>(undefined);
  const disposalRef = useRef<Promise<void> | undefined>(undefined);
  const [controller, setController] = useState<AppCallController>();
  const [bootError, setBootError] = useState<string>();
  const [bootGeneration, setBootGeneration] = useState(0);
  const [linkState, setLinkState] = useState<CallRtmLinkState>('disconnected');

  useSceneSessionLifecycle(session, () => {
    const current = controllerRef.current;
    controllerRef.current = undefined;
    rtmRef.current = undefined;
    if (current) disposalRef.current = current.dispose();
    return disposalRef.current ?? Promise.resolve();
  });

  useEffect(() => {
    if (!env.configured) return;
    let alive = true;
    const unbind = session.bindEvents({
      message: event => rtmRef.current?.handleMessage(event)
        ?? { consumed: false, reason: '呼叫信令尚未就绪' },
      linkState: () => {
        const next = session.getCurrentLinkState();
        setLinkState(next);
        onConnectionState?.(next);
        rtmRef.current?.handleLinkStateChange();
        controllerRef.current?.checkDeadlines();
      },
    });
    onTraceSources?.([toTraceSource(session)]);
    void session.login().then(() => {
      if (!alive) return;
      const rtm = new CallRtm({ userId: identity.uid, session });
      rtmRef.current = rtm;
      const next = new AppCallController({
        appId: env.appId, localUid: identity.uid, nickname: '', rtm,
        createAudio: () => createCallAudioSession(overrides?.createRtc?.() ?? createRtcHelper(undefined, getToken)),
      });
      controllerRef.current = next;
      setController(next);
      setBootError(undefined);
      const currentLinkState = session.getCurrentLinkState() === 'disconnected' ? 'connected' : session.getCurrentLinkState();
      setLinkState(currentLinkState);
      onConnectionState?.(currentLinkState);
    }).catch((error: unknown) => {
      if (alive) setBootError(error instanceof Error ? error.message : 'RTM 登录失败');
    });
    return () => {
      alive = false;
      unbind();
      const current = controllerRef.current;
      controllerRef.current = undefined;
      rtmRef.current = undefined;
      if (current) disposalRef.current = current.dispose();
      onTraceSources?.([]);
      onConnectionState?.(undefined);
    };
  }, [bootGeneration, env, identity.uid, onConnectionState, onTraceSources, overrides, session, getToken]);

  const experienceProgress = useOneToOneCallExperienceProgress(session, controller);
  useEffect(() => { onExperienceProgress?.(experienceProgress); }, [experienceProgress, onExperienceProgress]);
  useEffect(() => () => onExperienceProgress?.(undefined), [onExperienceProgress]);

  if (!env.configured) return null;
  if (bootError) {
    return (
      <section className="oc-status-card" role="alert">
        <span className="oc-eyebrow">LOGIN FAILED</span>
        <h1>RTM 登录失败</h1>
        <p>{bootError}</p>
        <button type="button" className="ink-button ink-button--primary" onClick={() => setBootGeneration((value) => value + 1)}>
          <RotateCcw size={16} aria-hidden="true" />重新初始化
        </button>
      </section>
    );
  }
  if (!controller) {
    return <section className="oc-status-card" role="status"><span className="oc-eyebrow">CONNECTING</span><h1>正在登录 RTM…</h1></section>;
  }
  return <CallWorkbench controller={controller} localUid={identity.uid} linkState={linkState} />;
}

function CallWorkbench({
  controller, localUid, linkState,
}: { controller: AppCallController; localUid: string; linkState: CallRtmLinkState }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [target, setTarget] = useState('');
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameError, setNicknameError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [, setClockTick] = useState(0);

  useEffect(() => {
    if (snapshot.call.status === 'IDLE' && !snapshot.incomingInvitations.length) return;
    const timer = window.setInterval(() => {
      controller.checkDeadlines();
      setClockTick((tick) => tick + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [controller, snapshot.call.status, snapshot.incomingInvitations.length]);

  useEffect(() => {
    const check = () => { controller.checkDeadlines(); setClockTick((tick) => tick + 1); };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [controller]);

  function updateNickname(value: string) {
    setNicknameDraft(value);
    const normalized = normalizeCallNickname(value);
    if ('error' in normalized) setNicknameError(normalized.error);
    else {
      setNicknameError(undefined);
      controller.setNickname(normalized.value);
    }
  }

  async function copyId() {
    await navigator.clipboard?.writeText(localUid);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  const call = snapshot.call;
  const clock = Date.now();
  const remaining = call.status !== 'IDLE'
    ? Math.max(0, Math.ceil((call.call.expiresAt - clock) / 1_000)) : 0;
  const activeSeconds = call.status === 'ACTIVE' ? Math.max(0, Math.floor((clock - call.startedAt) / 1_000)) : 0;
  const remoteLabel = call.status === 'IDLE' ? '' : call.call.remoteNickname || abbreviateUid(call.call.remoteUid);
  const signalingUnavailable = linkState !== 'connected';
  const normalizedTarget = target.trim();

  return (
    <section className="oc-workbench" data-testid="one-to-one-call-workbench">
      <header className="oc-workbench__header">
        <div><span className="oc-eyebrow">1V1 · AUDIO CALL</span><h1>呼叫、接听与真实音频</h1></div>
        <span className="oc-state-tag">{call.status}</span>
      </header>

      <div className="oc-workbench__body">
        <aside className="oc-identity-panel" aria-label="我的呼叫身份">
          <span className="oc-section-label">MY CALL ID</span>
          <div className="oc-call-id"><code>{localUid}</code><button type="button" className="oc-icon-button" onClick={() => void copyId()} title="复制呼叫 ID" aria-label="复制呼叫 ID"><Copy size={16} /></button></div>
          {copied && <span className="oc-inline-success" role="status">已复制</span>}
          <label className="oc-field"><span>你的昵称（选填）</span><input value={nicknameDraft} onChange={(event) => updateNickname(event.target.value)} disabled={call.status !== 'IDLE'} aria-invalid={Boolean(nicknameError)} /></label>
          {nicknameError && <span className="oc-field-error">{nicknameError}</span>}
        </aside>

        <main className="oc-call-stage">
          {call.status === 'IDLE' && (
            <form className="oc-dial-form" onSubmit={(event) => { event.preventDefault(); void controller.startCall(target); }}>
              <div className="oc-avatar" aria-hidden="true">{call.result ? <PhoneOff size={24} /> : <Phone size={24} />}</div>
              <div className="oc-stage-copy"><span className="oc-section-label">{call.result ? 'CALL ENDED' : 'READY'}</span><h2>{call.result ? RESULT_LABELS[call.result.reason] ?? '呼叫已结束' : '呼叫另一位在线用户'}</h2><p>{call.result ? '可以发起或接听新的呼叫。' : '输入对方页面显示的呼叫 ID。'}</p></div>
              <label className="oc-field oc-field--wide"><span>对方呼叫 ID</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="call-xxxxxxxxxxxx" /></label>
              <div className="oc-call-actions">
                <button type="submit" className="ink-button ink-button--primary" disabled={signalingUnavailable || !isValidCallUid(normalizedTarget) || normalizedTarget === localUid || Boolean(nicknameError)}><Phone size={17} />发起呼叫</button>
                {call.result && <button type="button" className="ink-button" onClick={() => controller.dismissResult()}>完成</button>}
              </div>
            </form>
          )}

          {(call.status === 'OUTGOING_SENDING' || call.status === 'OUTGOING_RINGING') && (
            <CallStatus avatar={<Phone size={25} />} eyebrow="OUTGOING" title={remoteLabel} detail={call.status === 'OUTGOING_RINGING' ? '对方正在响铃' : '正在发送邀请…'} timer={call.status === 'OUTGOING_RINGING' ? `${remaining}s` : ''}>
              <button type="button" className="ink-button ink-button--danger" onClick={() => void controller.cancel()}><PhoneOff size={17} />取消呼叫</button>
            </CallStatus>
          )}

          {snapshot.incomingInvitations.map((invitation) => {
            const label = invitation.remoteNickname || abbreviateUid(invitation.remoteUid);
            const waitingAck = invitation.state === CalleeInvitationState.ACCEPT_SENT_TO_CALLER;
            const remainingSeconds = Math.max(0, Math.ceil((invitation.endTs - clock) / 1_000));
            return (
              <article key={invitation.callId} aria-label={`来自${label}的来电`}>
                <CallStatus avatar={<Phone size={25} />} eyebrow="INCOMING CALL" title={label}
                  detail={waitingAck ? '等待主叫确认接听' : invitation.publishing ? '正在发送接听请求…' : '邀请你进行语音通话'} timer={`${remainingSeconds}s`}>
                  {!waitingAck && <>
                    <button type="button" className="ink-button" disabled={invitation.publishing || signalingUnavailable} onClick={() => void controller.refuse(invitation.callId)}><PhoneOff size={17} />拒绝</button>
                    <button type="button" className="ink-button ink-button--primary" disabled={!snapshot.canAcceptIncoming || invitation.publishing || signalingUnavailable} title={!snapshot.canAcceptIncoming ? '请先结束当前呼叫' : undefined} onClick={() => void controller.accept(invitation.callId)}><Phone size={17} />接听</button>
                  </>}
                </CallStatus>
              </article>
            );
          })}

          {call.status === 'MEDIA_CONNECTING' && (
            <CallStatus avatar={<Phone size={25} />} eyebrow="CONNECTING" title={remoteLabel} detail="正在建立音频连接" timer="···">
              <button type="button" className="oc-round-control oc-round-control--danger" onClick={() => void controller.end()} aria-label="挂断"><PhoneOff size={20} /></button>
            </CallStatus>
          )}

          {call.status === 'ACTIVE' && (
            <CallStatus avatar={<Phone size={25} />} eyebrow="CONNECTED" title={remoteLabel} detail={snapshot.audio.microphone === 'error' ? '麦克风不可用，你仍可听到对方' : '音频通话中'} timer={formatDuration(activeSeconds)}>
              {snapshot.audio.microphone === 'error' ? (
                <button type="button" className="ink-button" onClick={() => void controller.retryMicrophone()}><RotateCcw size={17} />重试麦克风</button>
              ) : (
                <button type="button" className="oc-round-control" onClick={() => void controller.toggleMute()} aria-label={snapshot.audio.microphone === 'muted' ? '打开麦克风' : '关闭麦克风'}>
                  {snapshot.audio.microphone === 'muted' ? <MicOff size={20} /> : <Mic size={20} />}
                </button>
              )}
              <button type="button" className="oc-round-control oc-round-control--danger" onClick={() => void controller.end()} aria-label="挂断"><PhoneOff size={20} /></button>
            </CallStatus>
          )}


        </main>
      </div>
      {signalingUnavailable && call.status !== 'ACTIVE' && (
        <div className="oc-link-overlay" role="status" aria-live="polite">
          <WifiOff size={20} aria-hidden="true" />
          <strong>{call.status === 'IDLE' && call.result?.reason === 'LOCAL_NETWORK_ERROR'
            ? '本地网络异常，呼叫失败' : 'RTM 连接中断，正在重连…'}</strong>
        </div>
      )}
      {signalingUnavailable && call.status === 'ACTIVE' && (
        <div className="oc-link-banner" role="status">RTM 正在重连，音频通话保持中</div>
      )}
      {snapshot.notice && <div className="oc-toast" role="status">{snapshot.notice}</div>}
    </section>
  );
}

function CallStatus({ avatar, eyebrow, title, detail, timer, children }: {
  avatar: ReactNode; eyebrow: string; title: string; detail: string; timer: string; children?: ReactNode;
}) {
  return (
    <div className="oc-call-status">
      <div className="oc-avatar oc-avatar--large" aria-hidden="true">{avatar}</div>
      <span className="oc-section-label">{eyebrow}</span>
      <h2>{title}</h2><p>{detail}</p>{timer && <time className="oc-call-timer">{timer}</time>}
      {children && <div className="oc-call-actions">{children}</div>}
    </div>
  );
}

function abbreviateUid(uid: string): string {
  return uid.length <= 16 ? uid : `${uid.slice(0, 8)}…${uid.slice(-4)}`;
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
