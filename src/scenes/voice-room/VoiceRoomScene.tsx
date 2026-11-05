import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
import { ArrowUpRight, CircleX, LockKeyhole, Radio } from "lucide-react";

import type { ResolvedEnv } from "../../app/env";
import { useSceneSessionLifecycle } from "../../app/sceneSessions";
import { createRtcHelper, type RtcHelper } from "../../shared/rtc";
import { getAgoraToken, type TokenProvider } from "../../shared/utils/token";
import type { TraceSource } from "../../shared/timeline/useMergedTraces";
import type { ExperienceProgress } from "../../shared/experience/types";
import { appPath } from "../../shared/paths";
import { useVoiceRoomExperienceProgress } from "./experienceProgress";
import { SEAT_COUNT } from "./config";
import { AppRtmSession, type AppRtmLinkState } from "./app-rtm";
import { SingleRoomClient } from "./event-driven-single-room-client";
import { normalizeRoomName } from "./room-name";
import { getNicknameInitial, normalizeNicknameInput } from "./nickname";
import { RoomEntryController } from "./room-entry-controller";
import {
  createVoiceRoomUrl,
  parseVoiceRoomUrl as parseVoiceRoomDataUrl,
  type VoiceRoomUrlPayload,
} from "./voice-room-url";

export interface VoiceRoomSceneProps {
  env: Extract<ResolvedEnv, { configured: true }>;
  search?: string;
  overrides?: {
    createAppRtmSession?: (appId: string, userId: string) => AppRtmSession;
    createRtc?: () => RtcHelper;
  };
  onTraceSources?: (sources: readonly TraceSource[]) => void;
  onExperienceProgress?: (progress: ExperienceProgress | undefined) => void;
  /** 页面级 RTM 连接状态，供外壳顶栏显示；场景卸载时上报 `undefined`。 */
  onConnectionState?: (state: AppRtmLinkState | undefined) => void;
}

export const parseVoiceRoomUrl = parseVoiceRoomDataUrl;

function VoiceRoomToast({
  message,
  tone = "default",
  placement = "header",
}: {
  message: string | undefined;
  tone?: "default" | "error";
  placement?: "header" | "page";
}) {
  if (!message) return null;
  return (
    <div
      className={`vr-toast-viewport vr-toast-viewport--${placement}`}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <p
        className={`vr-toast-message ${tone === "error" ? "vr-toast--error" : "vr-room-toast"}`}
        role={tone === "error" ? "alert" : "status"}
      >
        {tone === "error" && <CircleX size={16} aria-hidden="true" />}
        <span>{message}</span>
      </p>
    </div>
  );
}

function RoomCleanupNotice({ client, onDone }: { client: SingleRoomClient; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  return <div className="vr-entry__pending" role="alert">
    <span>“{client.getView().roomName}”已解散，数据清理未完成。</span>
    <button type="button" className="ink-button ink-button--small vr-entry__secondary" disabled={pending} onClick={() => {
      setPending(true);
      void client.retryRoomCleanup().then(onDone).catch(() => {}).finally(() => setPending(false));
    }}>{pending ? '正在清理…' : '重试清理'}</button>
  </div>;
}

/** Prevents duplicate direct-entry startup for the same resolved room identity. */
export function createDirectEntryStartGuard() {
  let lastKey: string | undefined;
  return {
    claim(entry: { role: string; roomId: string; userId?: string }): boolean {
      const key = `${entry.role}:${entry.roomId}:${entry.userId ?? ""}`;
      if (lastKey === key) return false;
      lastKey = key;
      return true;
    },
  };
}

function randomId(prefix: string): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}

function createE2eRtc(): RtcHelper {
  const noop = async () => undefined;
  return {
    registerEvents: () => undefined,
    join: noop,
    leave: noop,
    publishMicrophone: noop,
    unpublishMicrophone: noop,
    setMicrophoneMuted: noop,
    isMicrophoneCaptureHealthy: () => true,
    publishCamera: noop,
    unpublishCamera: noop,
    setCameraMuted: noop,
    getLocalVideoTrack: () => undefined,
  };
}

function traceSource(client: Pick<SingleRoomClient, 'getTraces' | 'subscribeTraces' | 'clearTraces'>): TraceSource {
  const sourceId = randomId('trace');
  let previous: ReturnType<SingleRoomClient['getTraces']> | undefined;
  let annotated: ReturnType<SingleRoomClient['getTraces']> = [];
  return {
    getEntries: () => {
      const current = client.getTraces();
      if (current !== previous) { previous = current; annotated = current.map(entry => ({ ...entry, sourceId })); }
      return annotated;
    },
    subscribe: (listener) => client.subscribeTraces(listener),
    clear: () => client.clearTraces(),
  };
}

function appTraceSource(session: AppRtmSession): TraceSource {
  return {
    getEntries: () => session.getTraces(),
    subscribe: (listener) => session.subscribeTraces(listener),
    clear: () => session.clearTraces(),
  };
}

const CHAT_EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "🙂",
  "🙃", "😉", "😍", "🥰", "😘", "😋", "😎", "🤓", "🧐", "🤩",
  "🥳", "😏", "😒", "😔", "😢", "😭", "😤", "😡", "🤯", "😱",
  "🥺", "😴", "🤒", "🤔", "🤭", "🤫", "🙄", "😬", "😇", "🤗",
  "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "✌️", "🤞", "👌",
  "👋", "🤟", "🤙", "💖", "💕", "💔", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "🔥", "✨", "🎉", "🎁", "🌹", "☕", "🎵", "💯",
] as const;

/** 麦位序号：`seat-0` → 1（业务文案）与 `01`（等宽编号）。 */
function seatOrdinal(seatId: string): number {
  return Number(seatId.replace("seat-", "")) + 1;
}

function seatCode(seatId: string): string {
  return String(seatOrdinal(seatId)).padStart(2, "0");
}

function CrownIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 18h18l1-11-5.5 4L12 4l-4.5 7L2 7z" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z" />
    </svg>
  );
}

function MicIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? <>
        <path d="M2 2l20 20" /><path d="M9 9v3a3 3 0 0 0 5.1 2.1" /><path d="M15 9.3V5a3 3 0 0 0-5.9-.7" /><path d="M5 10a7 7 0 0 0 11.5 5.4" /><path d="M19 10a7 7 0 0 1-.6 2.8" /><path d="M12 17v4" />
      </> : <>
        <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v4" />
      </>}
    </svg>
  );
}

/** 入口、加载与结束页共用的卡片骨架：等宽眉标 + 标题 + 说明 + 操作。 */
function StatusCard({
  testId,
  eyebrow,
  title,
  description,
  tone = "default",
  icon,
  live,
  role,
  children,
}: {
  testId?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  tone?: "default" | "danger";
  icon?: React.ReactNode;
  live?: "polite";
  role?: "status";
  children?: React.ReactNode;
}) {
  return (
    <section className="vr-entry vr-entry--status" data-testid={testId} aria-live={live} role={role}>
      <div className="vr-entry__inner">
        {icon && <span className="vr-entry__status-icon" data-tone={tone}>{icon}</span>}
        {eyebrow && <span className="ink-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
        {children}
      </div>
    </section>
  );
}

function VoiceRoomEnded({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <StatusCard testId="voice-room-ended" eyebrow="ROOM ENDED" title={message} tone="danger"
      description="本次体验已结束，可以返回入口，通过房间名称加入其他房间。"
      icon={<CircleX size={20} aria-hidden="true" />}>
      <button type="button" className="ink-button vr-entry__secondary" onClick={onBack}>返回房间入口</button>
    </StatusCard>
  );
}

type SeatMicState = "on" | "muted" | "forced" | "error" | "away";

function RoomSurface({
  client,
  onLeave,
  onDissolve,
  managing = false,
}: {
  client: SingleRoomClient;
  onLeave: () => void;
  onDissolve: () => Promise<void>;
  managing?: boolean;
}) {
  const view = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getView(),
  );
  const [selectedSeatId, setSelectedSeatId] = useState("seat-1");
  const [chat, setChat] = useState("");
  const chatEditVersion = useRef(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [transientError, setTransientError] = useState<string>();
  const [transientNotice, setTransientNotice] = useState<string>();
  const [actionPending, setActionPending] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const snapshot = view.snapshot;
  const roomStateReady = view.hasAuthoritativeSnapshot;
  const isHost = view.role === "host";
  const hasOwnSeat = Boolean(
    Object.values(view.snapshot?.seats ?? {}).some(
      (seat) => seat.userId === view.userId,
    ),
  );
  const ownSeatId = Object.values(snapshot?.seats ?? {}).find((seat) => seat.userId === view.userId)?.seatId;
  const roomTitle = view.roomName;
  const roomAnnouncement = snapshot?.announcement.trim() || "暂无公告";
  // 入房到收到权威 Storage 快照之间也保留完整麦位布局；这只是展示占位，不进 store。
  const seats = Object.values(snapshot?.seats ?? {});
  const displayedSeats = (
    seats.length > 0
      ? seats
      : Array.from({ length: SEAT_COUNT }, (_, index) => ({
          seatId: `seat-${index}`,
          userId: null,
          displayName: null,
        }))
  ).map((seat) => ({
    ...seat,
    displayName: seat.userId ? client.getMemberDisplayName(seat.userId) : null,
    status: seat.userId ? "active" as const : "empty" as const,
  }));
  const occupiedCount = displayedSeats.filter((seat) => seat.status === "active").length;
  const memberName = (userId: string) => client.getMemberDisplayName(userId);
  const audienceUserIds = view.onlineUsers.filter((userId) => userId !== view.userId);
  const selectedSeat = snapshot?.seats[selectedSeatId];
  const selectedMemberId = selectedSeat?.userId ?? undefined;
  const forcedMutedSelf = Boolean(snapshot?.forcedMutedUserIds.includes(view.userId));
  const seatRequestBlocked = !hasOwnSeat && view.hostTemporarilyAway;

  useEffect(() => {
    if (!view.error) return;
    setTransientError(view.error);
    const timer = window.setTimeout(() => setTransientError(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [view.errorVersion]);

  useEffect(() => {
    if (!view.notice) return;
    setTransientNotice(view.notice);
    const timer = window.setTimeout(() => setTransientNotice(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [view.noticeVersion]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!emojiPickerRef.current?.contains(event.target as Node)) setShowEmojiPicker(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowEmojiPicker(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showEmojiPicker]);

  const editChat = (value: string) => {
    chatEditVersion.current += 1;
    setChat(value);
  };

  const insertEmoji = (emoji: string) => {
    const input = chatInputRef.current;
    const start = input?.selectionStart ?? chat.length;
    const end = input?.selectionEnd ?? start;
    const next = `${chat.slice(0, start)}${emoji}${chat.slice(end)}`;
    const caret = start + emoji.length;
    editChat(next);
    queueMicrotask(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  useLayoutEffect(() => {
    const feed = chatFeedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [view.interactions]);

  /** 麦位状态词与图标：只表达 Presence / Storage 派生的媒体状态，不改归属。 */
  const describeSeat = (seat: (typeof displayedSeats)[number]) => {
    const forcedMuted = Boolean(seat.userId && snapshot?.forcedMutedUserIds.includes(seat.userId));
    const voluntarilyMuted = Boolean(seat.userId && view.memberMuted[seat.userId]);
    const microphoneError = Boolean(seat.userId && view.memberMicrophoneErrors[seat.userId]);
    const hostAway = Boolean(seat.userId && seat.userId === snapshot?.hostUserId && view.hostTemporarilyAway);
    const muted = forcedMuted || voluntarilyMuted;
    const isSpeaking = Boolean(
      seat.userId && seat.status === "active" && !muted && !microphoneError && !hostAway &&
      (view.volumes[seat.userId] ?? 0) >= 35,
    );
    const mic: SeatMicState = hostAway ? "away" : microphoneError ? "error" : forcedMuted ? "forced" : voluntarilyMuted ? "muted" : "on";
    const label = hostAway ? "AWAY" : microphoneError ? "MIC ERROR" : forcedMuted ? "FORCED MUTED" : voluntarilyMuted ? "MUTED" : isSpeaking ? "SPEAKING" : "MIC ON";
    const title = hostAway ? "房主暂时离开" : microphoneError ? "麦克风设备异常" : forcedMuted ? "已被强制静音" : voluntarilyMuted ? "已闭麦" : isSpeaking ? "正在说话" : "麦克风已开";
    return { forcedMuted, voluntarilyMuted, microphoneError, hostAway, muted, isSpeaking, mic, label, title };
  };

  /** 听众点击空麦位即申请该麦位；房主与不可申请的情况只做选中。 */
  const onSeatClick = (seat: (typeof displayedSeats)[number]) => {
    setSelectedSeatId(seat.seatId);
    if (!roomStateReady || isHost || seat.status !== "empty" || hasOwnSeat || view.waitingSeatId || seatRequestBlocked) return;
    void client.requestSeat(seat.seatId);
  };

  /** 邀请听众上麦：优先当前选中的空麦位，否则取第一个空麦位。 */
  const inviteToSeat = (userId: string) => {
    const target = snapshot?.seats[selectedSeatId]?.userId
      ? displayedSeats.find((seat) => seat.status === "empty")?.seatId
      : selectedSeatId;
    if (!target) { setTransientError("没有空麦位可邀请"); return; }
    void client.invite(userId, target);
  };

  if (view.endedReason && dissolving) return <StatusCard role="status" title="正在返回房间入口…" icon={<Radio size={20} aria-hidden="true" />} />;
  if (view.endedReason) return <VoiceRoomEnded message={view.endedReason} onBack={onLeave} />;
  const selected = selectedSeat?.userId ? describeSeat(displayedSeats.find((seat) => seat.seatId === selectedSeatId)!) : undefined;
  return (
    <section
      className="vr-single"
      data-role={view.role}
      aria-label={isHost ? "房主语聊房" : "听众语聊房"}
    >
      <header className="vr-single__header">
        <div className="vr-single__identity">
          <span className="vr-single__role-badge">{isHost ? "HOST" : "AUDIENCE"}</span>
          <h2 className="vr-single__title">{roomTitle}</h2>
        </div>
        <div className="vr-single__header-actions">
          {isHost ? (
            <>
              <button type="button" className="ink-button" aria-label="暂时离开" disabled={managing || actionPending} onClick={onLeave}>暂时离开</button>
              <button
                type="button"
                className="ink-button ink-button--danger"
                aria-label="解散房间"
                disabled={managing || actionPending}
                onClick={() => { setActionPending(true); setDissolving(true); void onDissolve().finally(() => { setActionPending(false); setDissolving(false); }); }}
              >
                解散房间
              </button>
            </>
          ) : (
            <button type="button" className="ink-button" aria-label="退出房间" disabled={managing || actionPending} onClick={onLeave}>退出房间</button>
          )}
        </div>
      </header>
      <VoiceRoomToast
        message={transientError ?? transientNotice}
        tone={transientError ? "error" : "default"}
      />
      <div className="vr-single__stage">
        <div className="vr-single__section-heading">
          <div>
            <span>麦位</span>
            <span className="vr-single__meta">{occupiedCount} / {SEAT_COUNT} · {view.onlineUsers.length} ONLINE</span>
          </div>
          <small>{isHost ? "选择麦位以管理嘉宾" : "选择空麦位申请上麦"}</small>
        </div>
        <section className="vr-single__seats" aria-label="麦位">
          {displayedSeats.map((seat) => {
            const info = describeSeat(seat);
            const isHostSeat = Boolean(seat.userId && seat.userId === snapshot?.hostUserId);
            const waiting = !isHost && view.waitingSeatId === seat.seatId;
            const invited = !isHost && view.invitation?.seatId === seat.seatId;
            const emptyLabel = waiting ? "WAITING" : invited ? "INVITED" : "OPEN";
            return (
              <button
                key={seat.seatId}
                type="button"
                className="vr-single__seat"
                data-selected={selectedSeatId === seat.seatId}
                data-state={seat.status}
                data-mic={seat.status === "active" ? info.mic : undefined}
                data-muted={info.muted}
                data-forced-muted={info.forcedMuted}
                data-microphone-error={info.microphoneError}
                data-host-away={info.hostAway}
                data-speaking={info.isSpeaking}
                data-waiting={waiting}
                data-invited={invited}
                disabled={!roomStateReady}
                aria-label={seat.status === "active"
                  ? `${seatOrdinal(seat.seatId)} 号麦位 ${seat.displayName} ${info.title}`
                  : `${seatOrdinal(seat.seatId)} 号麦位 空麦位`}
                onClick={() => onSeatClick(seat)}
              >
                {isHostSeat ? (
                  <span className="vr-single__seat-host" role="img" aria-label="房主" title="房主"><CrownIcon /></span>
                ) : (
                  <span className="vr-single__seat-number">{seatCode(seat.seatId)}</span>
                )}
                <span className="vr-single__seat-avatar" aria-hidden="true">
                  {getNicknameInitial(seat.displayName)}
                </span>
                <span className="vr-single__seat-copy">
                  <strong>{seat.displayName ?? "空麦位"}</strong>
                  <small>{seat.status === "active" ? info.label : emptyLabel}</small>
                </span>
                {seat.status === "active" && (
                  <span className="vr-single__seat-mic" title={info.title}>
                    <MicIcon off={info.muted || info.microphoneError || info.hostAway} />
                  </span>
                )}
              </button>
            );
          })}
        </section>
        <div className="vr-single__section-heading vr-single__section-heading--divided">
          <div><span>公告</span><span className="vr-single__meta">PINNED</span></div>
        </div>
        <p className="vr-single__announcement" title={roomAnnouncement}>{roomAnnouncement}</p>
        <div className="vr-single__section-heading vr-single__section-heading--divided">
          <div><span>公屏</span><span className="vr-single__meta">{view.interactions.length} MESSAGES</span></div>
        </div>
        <section className="vr-single__chat" aria-label="互动消息">
          <div className="vr-single__chat-feed" ref={chatFeedRef} data-testid="voice-room-chat-feed" tabIndex={0} role="region" aria-label="公屏消息，可上下滚动">
            {view.interactions.length === 0 ? (
              <p className="vr-single__chat-empty">和大家打个招呼，开始互动吧</p>
            ) : (
              view.interactions.map((item) => (
                <p
                  key={item.id}
                  className={item.type.startsWith("system-") ? "vr-single__system-message" : undefined}
                  data-interaction-type={item.type}
                >
                  {item.type.startsWith("system-") ? (
                    <span>{item.value}</span>
                  ) : (
                    <>
                      <strong>{item.displayName}</strong>
                      <span>
                        {item.type === "gift"
                          ? ` 送出礼物 ${item.value}`
                          : item.type === "emoji"
                            ? ` 送出爱心 ${item.value}`
                            : ` ${item.value}`}
                      </span>
                    </>
                  )}
                </p>
              ))
            )}
          </div>
        </section>
      </div>
      <div className="vr-single__composer">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const sentEditVersion = chatEditVersion.current;
            void client
              .sendInteraction("chat.message", chat)
              .then(() => {
                // Re-entering the same text still creates a new draft.
                if (chatEditVersion.current === sentEditVersion) setChat("");
              })
              .catch((error) => setTransientError(error instanceof Error ? error.message : "聊天发送失败，请重试"));
          }}
        >
          <div className="vr-single__emoji-control" ref={emojiPickerRef}>
            <button
              type="button"
              className="ink-button ink-button--icon vr-single__quick-action"
              aria-label={showEmojiPicker ? "关闭 Emoji 选择器" : "打开 Emoji 选择器"}
              aria-expanded={showEmojiPicker}
              title="Emoji"
              onClick={() => setShowEmojiPicker((visible) => !visible)}
            >
              😊
            </button>
            {showEmojiPicker && (
              <div className="vr-single__emoji-picker" role="dialog" aria-label="Emoji 选择器">
                {CHAT_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`插入 ${emoji}`}
                    title={emoji}
                    onClick={() => insertEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ink-button ink-button--icon vr-single__quick-action"
            aria-label="发送礼物消息"
            title="送礼物"
            onClick={() => void client.sendInteraction("gift.sent", "🎁")}
          >
            <GiftIcon />
          </button>
          <button
            type="button"
            className="ink-button ink-button--icon vr-single__quick-action"
            aria-label="发送爱心消息"
            title="点赞"
            onClick={() => void client.sendInteraction("emoji.reaction", "❤️")}
          >
            <HeartIcon />
          </button>
          <input
            ref={chatInputRef}
            className="ink-input"
            aria-label="聊天内容"
            placeholder="说点什么…"
            value={chat}
            onChange={(event) => editChat(event.target.value)}
          />
          <button type="submit" className="ink-button ink-button--primary" aria-label="发送聊天" disabled={!chat.trim()}>
            发送
          </button>
          {hasOwnSeat && (
            <button
              type="button"
              className="ink-button vr-single__mic-action"
              disabled={!roomStateReady || forcedMutedSelf}
              onClick={() => void client.setOwnMuted(!view.ownMuted)}
            >
              {forcedMutedSelf ? "已被静音" : view.ownMuted ? "开麦" : "闭麦"}
            </button>
          )}
          {!isHost && (hasOwnSeat ? (
            <button type="button" className="ink-button vr-single__seat-action" onClick={() => void client.leaveSeat()}>
              下麦
            </button>
          ) : (
            <button
              type="button"
              className="ink-button ink-button--outline vr-single__seat-action"
              disabled={!roomStateReady || Boolean(view.waitingSeatId) || seatRequestBlocked}
              title={seatRequestBlocked ? "房主暂时离开，无法处理上麦申请" : undefined}
              onClick={() => void client.requestSeat(selectedSeatId)}
            >
              {view.waitingSeatId ? "等待审批" : "申请上麦"}
            </button>
          ))}
        </form>
      </div>
      {isHost ? (
        <aside className="vr-single__panel" aria-label="房间控制台">
          {selectedSeat?.userId && selected && (
            <section className="vr-single__control-group vr-single__context-card">
              <header>
                <span>已选 · {seatCode(selectedSeatId)} {memberName(selectedSeat.userId)}</span>
                <span className="vr-single__context-state" data-tone={selected.mic === "on" ? "success" : undefined}>{selected.label}</span>
              </header>
              {selectedMemberId && selectedMemberId !== view.userId ? (
                <div className="vr-single__context-actions">
                  <button type="button" className="ink-button" disabled={!roomStateReady} onClick={() => void client.forceMute(selectedMemberId, !selected.forcedMuted)}>
                    {selected.forcedMuted ? "解除静音" : "静音"}
                  </button>
                  <button type="button" className="ink-button" disabled={!roomStateReady} onClick={() => void client.forceLeave(selectedMemberId)}>下麦</button>
                  <button type="button" className="ink-button ink-button--danger" disabled={!roomStateReady} aria-label={`踢出${memberName(selectedMemberId)}`} onClick={() => void client.kickMember(selectedMemberId)}>踢出</button>
                </div>
              ) : (
                <p className="vr-single__empty">这是你的麦位，可在底部输入条闭麦或开麦。</p>
              )}
            </section>
          )}
          <section className="vr-single__control-group">
            <div className="vr-single__control-heading">
              <span>排麦申请</span>
              <small>{view.queue.length} 等待</small>
            </div>
            <div className="vr-single__request-list">
              {view.queue.length === 0 ? (
                <p className="vr-single__empty">暂时没有排麦申请，有人申请后会显示在这里</p>
              ) : (
                view.queue.map((request) => (
                  <article key={request.id} className="vr-single__request">
                    <div>
                      <strong>{request.displayName}</strong>
                      <small>→ SEAT {seatCode(request.seatId)} · {request.remainingSeconds}s</small>
                    </div>
                    <div className="vr-single__request-actions">
                      <button
                        type="button"
                        className="ink-button ink-button--primary ink-button--small"
                        aria-label={`同意${request.displayName}上麦`}
                        disabled={!roomStateReady}
                        onClick={() => void client.approveSeatRequest(request.id)}
                      >
                        同意
                      </button>
                      <button
                        type="button"
                        className="ink-button ink-button--small"
                        aria-label={`拒绝${request.displayName}上麦`}
                        disabled={!roomStateReady}
                        onClick={() => void client.rejectSeatRequest(request.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
          <section className="vr-single__control-group">
            <div className="vr-single__control-heading"><span>更新公告</span></div>
            <div className="vr-single__field">
              <input
                className="ink-input"
                aria-label="房间公告"
                placeholder="写一句欢迎语…"
                value={announcement}
                onChange={(event) => setAnnouncement(event.target.value)}
              />
              <button type="button" className="ink-button ink-button--primary" disabled={!roomStateReady || !announcement.trim()} onClick={() => void client.updateAnnouncement(announcement)}>
                发布
              </button>
            </div>
          </section>
          <section className="vr-single__control-group vr-single__member-list" aria-label="房间成员管理">
            <div className="vr-single__control-heading">
              <span>在线听众</span>
              <small>{audienceUserIds.length}</small>
            </div>
            {audienceUserIds.length === 0 && <p className="vr-single__empty">还没有听众加入</p>}
            {audienceUserIds.map((userId) => (
              <article key={userId} className="vr-single__member-row">
                <span>{memberName(userId)}</span>
                <span className="vr-single__member-row-actions">
                  <button type="button" className="ink-text-link" aria-label={`邀请${memberName(userId)}上麦`} disabled={!roomStateReady} onClick={() => inviteToSeat(userId)}>邀请上麦</button>
                  <button type="button" className="ink-text-link" aria-label={`踢出${memberName(userId)}`} disabled={!roomStateReady || actionPending} onClick={() => { setActionPending(true); void client.kickMember(userId).finally(() => setActionPending(false)); }}>踢出</button>
                  <button type="button" className="ink-text-link ink-text-link--danger vr-single__danger" aria-label={`封禁${memberName(userId)}`} disabled={!roomStateReady || managing || actionPending} onClick={() => { setActionPending(true); void client.banMember(userId).catch(error => setTransientError(error instanceof Error ? error.message : "封禁同步失败，请重试")).finally(() => setActionPending(false)); }}>封禁</button>
                </span>
              </article>
            ))}
          </section>
        </aside>
      ) : (
        <aside className="vr-single__panel" aria-label="我的状态">
          {view.invitation && (
            <section className="vr-single__control-group vr-single__context-card vr-single__inline-invitation" role="status">
              <header>
                <span>房主邀请你上麦</span>
                <span className="vr-single__context-state">SEAT {seatCode(view.invitation.seatId)}</span>
              </header>
              <div className="vr-single__context-actions vr-single__context-actions--two">
                <button type="button" className="ink-button ink-button--primary" onClick={() => void client.acceptInvitation()}>接受</button>
                <button type="button" className="ink-button" onClick={() => void client.rejectInvitation()}>拒绝</button>
              </div>
            </section>
          )}
          <section className="vr-single__control-group">
            <div className="vr-single__control-heading"><span>我的状态</span></div>
            <div className="vr-single__status-row"><span>身份</span><span className="vr-single__status-value">AUDIENCE</span></div>
            <div className="vr-single__status-row"><span>昵称</span><span className="vr-single__status-value vr-single__status-value--text vr-single__nickname">{view.displayName}</span></div>
            <div className="vr-single__status-row">
              <span>{hasOwnSeat ? "麦位" : "申请中"}</span>
              <span className={`vr-single__status-value ${hasOwnSeat || view.waitingSeatId ? "" : "vr-single__status-value--muted"}`}>
                {ownSeatId ? `SEAT ${seatCode(ownSeatId)}` : view.waitingSeatId ? `SEAT ${seatCode(view.waitingSeatId)}` : "—"}
              </span>
            </div>
          </section>
          <section className="vr-single__control-group">
            <div className="vr-single__control-heading">
              <span>在线听众</span>
              <small>{audienceUserIds.filter((userId) => userId !== snapshot?.hostUserId).length}</small>
            </div>
            {audienceUserIds.filter((userId) => userId !== snapshot?.hostUserId).map((userId) => (
              <article key={userId} className="vr-single__member-row"><span>{memberName(userId)}</span></article>
            ))}
          </section>
        </aside>
      )}
    </section>
  );
}




export function VoiceRoomScene({
  env,
  search = window.location.search,
  overrides,
  onTraceSources,
  onExperienceProgress,
  onConnectionState,
}: VoiceRoomSceneProps) {
  const directPayload = useMemo(() => parseVoiceRoomDataUrl(search), [search]);
  const pageUid = directPayload?.pageUid ?? randomId("user");
  const getToken = useMemo<TokenProvider | undefined>(() => env.auth
    ? request => getAgoraToken(request, env.auth) : undefined, [env.auth]);
  const [appRtm] = useState(() => overrides?.createAppRtmSession?.(env.appId, pageUid)
    ?? new AppRtmSession(env.appId, pageUid, { getToken }));
  const pageTraceSource = useMemo(() => appTraceSource(appRtm), [appRtm]);
  const accumulatedTraceSourcesRef = useRef<TraceSource[]>([pageTraceSource]);
  const clientTraceSourcesRef = useRef(new WeakMap<SingleRoomClient, TraceSource>());
  const onTraceSourcesRef = useRef(onTraceSources);
  onTraceSourcesRef.current = onTraceSources;
  const [controller] = useState(() => new RoomEntryController({
    appId: env.appId,
    session: appRtm,
    createRtc: overrides?.createRtc ?? (import.meta.env.MODE === "e2e"
      ? createE2eRtc : () => createRtcHelper(undefined, getToken)),
    replaceUrl: (payload) => {
      const url = createVoiceRoomUrl(window.location.origin, payload);
      window.history.replaceState(null, "", new URL(url).pathname + new URL(url).search);
    },
  }));
  const entryView = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getView(),
  );
  const [bootState, setBootState] = useState<"booting" | "ready" | "error">("booting");
  const [bootError, setBootError] = useState<string>();
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [roomName, setRoomName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [hostNickname, setHostNickname] = useState(() => directPayload?.role === "host" ? directPayload.nickname ?? "" : "");
  const [audienceNickname, setAudienceNickname] = useState(() => directPayload?.role === "audience" ? directPayload.nickname ?? "" : "");
  const [hostNicknamePasteError, setHostNicknamePasteError] = useState<string>();
  const [audienceNicknamePasteError, setAudienceNicknamePasteError] = useState<string>();
  const [resumeHostPayload, setResumeHostPayload] = useState<VoiceRoomUrlPayload>();
  const [cleanupFailures, setCleanupFailures] = useState<SingleRoomClient[]>([]);
  const [toast, setToast] = useState<string>();
  const directStarted = useRef(false);

  useEffect(() => {
    let active = true;
    setBootState("booting");
    setBootError(undefined);
    void appRtm.login().then(() => {
      if (active) setBootState("ready");
    }).catch((error) => {
      if (!active) return;
      setBootError(error instanceof Error ? error.message : "RTM 登录失败");
      setBootState("error");
    });
    return () => { active = false; };
  }, [loginAttempt, appRtm]);

  useSceneSessionLifecycle(appRtm, () => controller.leaveRoom());

  useEffect(() => {
    if (bootState !== "ready" || !directPayload || directStarted.current) return;
    directStarted.current = true;
    const entering = directPayload.role === "audience"
      ? controller.joinAudienceFromUrlPayload(directPayload)
      : controller.restoreHostFromUrlPayload(directPayload);
    void entering.catch((error) => {
      setToast(error instanceof Error ? error.message : "加入房间失败");
    });
  }, [bootState, controller, directPayload]);

  // 页面级 linkState 由应用级 listener 记录为 trace；订阅 trace 变化即可跟随连接状态，不轮询。
  const linkState = useSyncExternalStore(
    (listener) => appRtm.subscribeTraces(listener),
    () => appRtm.getCurrentLinkState(),
  );
  const connectionState: AppRtmLinkState = bootState === "booting" && linkState === "disconnected" ? "connecting" : linkState;
  useEffect(() => { onConnectionState?.(connectionState); }, [connectionState, onConnectionState]);
  useEffect(() => () => onConnectionState?.(undefined), [onConnectionState]);

  const client = entryView.client;
  const roomView = useSyncExternalStore(
    (listener) => client?.subscribe(listener) ?? (() => {}),
    () => client?.getView(),
  );
  const experienceProgress = useVoiceRoomExperienceProgress(appRtm, client, entryView.phase === "room");
  useEffect(() => { onExperienceProgress?.(experienceProgress); }, [experienceProgress, onExperienceProgress]);
  useEffect(() => () => onExperienceProgress?.(undefined), [onExperienceProgress]);
  useEffect(() => {
    if (client && !clientTraceSourcesRef.current.has(client)) {
      const source = traceSource(client);
      clientTraceSourcesRef.current.set(client, source);
      accumulatedTraceSourcesRef.current.push(source);
    }
    onTraceSources?.([...accumulatedTraceSourcesRef.current]);
  }, [client, onTraceSources, pageTraceSource]);

  useEffect(() => () => onTraceSourcesRef.current?.([]), []);

  useEffect(() => {
    if (!client || entryView.phase !== "room") return;
    let timeout = 0;
    const arm = () => {
      timeout = window.setTimeout(() => {
        void client.leaveRoom("五分钟无操作，本次体验已结束");
      }, 5 * 60 * 1000);
    };
    const reset = () => { window.clearTimeout(timeout); arm(); };
    arm();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    window.addEventListener("touchstart", reset);
    window.addEventListener("input", reset);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
      window.removeEventListener("touchstart", reset);
      window.removeEventListener("input", reset);
    };
  }, [client, entryView.phase]);

  if (bootState === "booting") {
    return (
      <StatusCard testId="voice-room-booting" live="polite" eyebrow="CONNECTING" title="正在初始化 RTM…"
        description="完成登录后即可创建或加入房间。" icon={<Radio size={20} aria-hidden="true" />} />
    );
  }

  if (bootState === "error") {
    return (
      <StatusCard testId="voice-room-boot-error" eyebrow="LOGIN FAILED" tone="danger" title="RTM 登录失败" description={bootError}
        icon={<CircleX size={20} aria-hidden="true" />}>
        <button type="button" className="ink-button ink-button--primary vr-entry__primary" onClick={() => setLoginAttempt((value) => value + 1)}>重新登录</button>
      </StatusCard>
    );
  }

  if (entryView.phase === "ended") {
    return <VoiceRoomEnded message={entryView.error ?? "房间已结束"} onBack={() => { void controller.leaveRoom(); }} />;
  }

  if (client && (entryView.phase === "subscribing" || entryView.phase === "room")) {
    return (
      <section className="vr-room-stage">
        <div inert={entryView.phase === 'subscribing' || !roomView?.roomMetadataFresh}>
        <RoomSurface
          client={client}
          onLeave={() => {
            const endedReason = client.getView().endedReason;
            if (endedReason) {
              setResumeHostPayload(undefined);
              window.history.replaceState(null, '', appPath('/social/voice-room'));
            } else if (entryView.payload?.role === 'host') {
              setResumeHostPayload(entryView.payload);
            }
            void controller.leaveRoom();
          }}
          managing={entryView.managing}
          onDissolve={async () => {
            setToast(undefined);
            try {
              await client.dissolveRoom();
            } catch (error) {
              // A confirmed end can outlive a failed broadcast or unsubscribe.
              if (client.getView().endedReason !== '房间已解散') {
                setToast(error instanceof Error ? error.message : '解散尚未确认，请重试');
                return;
              }
            }
            if (client.getView().roomCleanupError) {
              setCleanupFailures(current => current.includes(client) ? current : [...current, client]);
            }
            setResumeHostPayload(undefined);
            // Keep the page session and accumulated traces; discard the ended-room URL.
            window.history.replaceState(null, '', appPath('/social/voice-room'));
            await controller.leaveRoom();
          }}
        />
        </div>
        {entryView.phase === "subscribing" && (
          <div className="vr-room-loading" role="status" aria-live="polite" data-testid="voice-room-loading-overlay">
            <Radio size={20} aria-hidden="true" />
            <strong>{entryView.statusText ?? '正在加载房间…'}</strong>
            <button type="button" className="ink-button ink-button--small vr-entry__secondary" onClick={() => { void controller.leaveRoom(); }}>取消</button>
          </div>
        )}
        {entryView.phase === 'room' && roomView?.roomMetadataFresh === false && (
          <div className="vr-room-loading" role="status">
            <strong>连接中断，正在确认房间状态…</strong>
            <button type="button" className="ink-button ink-button--small" onClick={() => { void controller.leaveRoom(); }}>返回入口</button>
          </div>
        )}
        {entryView.managing && <p className="vr-entry__pending" role="status">正在同步房间状态…</p>}
        <VoiceRoomToast message={toast} tone="error" />
      </section>
    );
  }

  const pending = entryView.phase === 'admitting';
  const nameError = (value: string) => {
    if (!value) return undefined;
    try { normalizeRoomName(value); return undefined; } catch (error) { return (error as Error).message; }
  };
  const createError = nameError(roomName), joinError = nameError(joinName);
  const nicknameError = (value: string) => {
    try { normalizeNicknameInput(value); return undefined; } catch (error) { return (error as Error).message; }
  };
  const hostNicknameError = hostNicknamePasteError ?? nicknameError(hostNickname);
  const audienceNicknameError = audienceNicknamePasteError ?? nicknameError(audienceNickname);
  const canCreate = !pending && !!roomName.trim() && !createError && !hostNicknameError;
  const canJoin = !pending && !!joinName.trim() && !joinError && !audienceNicknameError;
  const reportFailure = (error: unknown) => setToast(error instanceof Error ? error.message : '房间操作失败，请重试');
  const createByName = () => {
    if (!canCreate) return;
    setToast(undefined);
    void controller.createHostRoom({ roomName, nickname: hostNickname }).catch(reportFailure);
  };
  const joinByName = () => {
    if (!canJoin) return;
    setToast(undefined);
    void controller.joinAudienceByName(joinName, audienceNickname).catch(reportFailure);
  };
  const resumeAsHost = () => {
    if (!resumeHostPayload || pending) return;
    setToast(undefined);
    void controller.restoreHostFromUrlPayload(resumeHostPayload)
      .then(() => setResumeHostPayload(undefined))
      .catch(reportFailure);
  };
  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>, submit: () => void) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    submit();
  };
  const pasteNickname = (event: ReactClipboardEvent<HTMLInputElement>, setError: (error: string | undefined) => void) => {
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const candidate = input.value.slice(0, start) + event.clipboardData.getData('text/plain') + input.value.slice(end);
    try {
      // Validate before a text input strips pasted CR/LF; valid pastes remain native.
      normalizeNicknameInput(candidate);
      setError(undefined);
    } catch (error) {
      event.preventDefault();
      setError((error as Error).message);
    }
  };

  return (
    <section className="vr-entry vr-entry--landing" data-testid="voice-room-entry">
      <div className="vr-entry__inner">
        <div className="vr-entry__intro">
          <span className="ink-eyebrow">01 · VOICE ROOM</span>
          <h1>语聊房：麦位与房内互动</h1>
          <p>创建房间成为房主，输入相同名称加入成为听众。右侧数据流实时记录 RTM 调用与事件。</p>
        </div>
        <div className="vr-entry__choices">
          <section className="vr-entry__choice-panel vr-entry__choice--host">
            <span className="ink-eyebrow">CREATE · HOST</span>
            <label>
              房间名称
              <input className="ink-input" aria-label="房间标题" aria-describedby="create-name-hint" aria-invalid={!!createError} disabled={pending} value={roomName} onChange={(event) => setRoomName(event.target.value)} onKeyDown={event => submitOnEnter(event, createByName)} placeholder="例如：周五晚间语聊" />
            </label>
            <p id="create-name-hint" className={`vr-entry__hint ${createError ? 'vr-entry__hint--error' : ''}`}>{createError ?? '名称唯一，最多 32 个字符；英文不区分大小写。'}</p>
            <label>
              你的昵称（选填）
              <input className="ink-input" aria-label="房主昵称" aria-describedby="host-nickname-hint" aria-invalid={!!hostNicknameError} disabled={pending} value={hostNickname} onChange={event => { setHostNickname(event.target.value); setHostNicknamePasteError(undefined); }} onPaste={event => pasteNickname(event, setHostNicknamePasteError)} onKeyDown={event => submitOnEnter(event, createByName)} placeholder="例如：小明" />
            </label>
            <p id="host-nickname-hint" className={`vr-entry__hint ${hostNicknameError ? 'vr-entry__hint--error' : ''}`}>{hostNicknameError ?? '不填使用 Host；最多 20 个字符'}</p>
            {resumeHostPayload && (
              <button type="button" className="ink-button ink-button--outline vr-entry__primary" disabled={pending} onClick={resumeAsHost}>以 Host 身份返回</button>
            )}
            <button type="button" className="ink-button ink-button--primary vr-entry__primary" disabled={!canCreate} onClick={createByName}>创建并进入</button>
          </section>
          <section className="vr-entry__choice-panel">
            <span className="ink-eyebrow">JOIN · AUDIENCE</span>
            <label>
              房间名称
              <input className="ink-input" aria-label="加入的房间名称" aria-describedby="join-name-hint" aria-invalid={!!joinError} disabled={pending} value={joinName} onChange={event => setJoinName(event.target.value)} onKeyDown={event => submitOnEnter(event, joinByName)} placeholder="输入房主告诉你的房间名称" />
            </label>
            <p id="join-name-hint" className={`vr-entry__hint ${joinError ? 'vr-entry__hint--error' : ''}`}>{joinError ?? <>同机体验？<a className="ink-inline-link" href={appPath('/social/voice-room')} target="_blank" rel="noopener noreferrer">新开听众页<ArrowUpRight size={13} aria-hidden="true" /></a></>}</p>
            <label>
              你的昵称（选填）
              <input className="ink-input" aria-label="观众昵称" aria-describedby="audience-nickname-hint" aria-invalid={!!audienceNicknameError} disabled={pending} value={audienceNickname} onChange={event => { setAudienceNickname(event.target.value); setAudienceNicknamePasteError(undefined); }} onPaste={event => pasteNickname(event, setAudienceNicknamePasteError)} onKeyDown={event => submitOnEnter(event, joinByName)} placeholder="例如：小雨" />
            </label>
            <p id="audience-nickname-hint" className={`vr-entry__hint ${audienceNicknameError ? 'vr-entry__hint--error' : ''}`}>{audienceNicknameError ?? '不填自动分配昵称；最多 20 个字符'}</p>
            <button type="button" className="ink-button ink-button--outline vr-entry__primary" disabled={!canJoin} onClick={joinByName}>加入房间</button>
          </section>
        </div>
        {pending && <div className="vr-entry__pending" role="status"><span>{entryView.statusText}</span><button type="button" className="ink-button ink-button--small vr-entry__secondary" onClick={() => { void controller.leaveRoom(); }}>取消</button></div>}
        {cleanupFailures.map(failed => <RoomCleanupNotice key={failed.getView().roomId} client={failed}
          onDone={() => setCleanupFailures(current => current.filter(value => value !== failed))} />)}
        <p className="vr-entry__footnote">使用耳机可获得更好的语音体验</p>
      </div>
      <VoiceRoomToast message={toast ?? entryView.error} tone="error" placement="page" />
    </section>
  );
}
