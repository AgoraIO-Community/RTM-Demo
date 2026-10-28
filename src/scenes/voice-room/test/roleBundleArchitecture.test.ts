import { describe, expect, it } from 'vitest';

const BUSINESS_TOKENS = [
  'VoiceRoomSnapshot',
  'VoiceRoomStateAdapter',
];

const REMOVED_MECHANISM_TOKENS = [
  'getChannelMetadata',
  'acquireLock',
  'subscribeMessageChannel',
  ':seat-requests',
];

const sources = import.meta.glob(['./{host,audience}/*.ts', './rtm-*.ts', './{orchestrator,single-room-client}.ts', './app-rtm.ts', './event-driven-single-room-client.ts', './VoiceRoomScene.tsx'], {
  base: '../',
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

function runtimeImports(source: string): string[] {
  return Array.from(source.matchAll(/^import\s+(?!type\b)[^'"\n]*['"]([^'"]+)['"]/gm), (match) =>
    match[1],
  );
}

function publicMethods(source: string): string[] {
  const classBody = source.slice(source.indexOf('export class '));
  return Array.from(classBody.matchAll(/^  (?:async )?([A-Za-z]\w*)\(/gm), (match) => match[1])
    .filter((name) => name !== 'constructor');
}

function uncommentedFunctionLines(source: string): number[] {
  const functionPattern = /^(?:export )?function\s+[A-Za-z]\w*\s*\(|^  (?!if\b|for\b|while\b|switch\b|catch\b|return\b)(?:(?:private|public|protected) )?(?:async )?[A-Za-z]\w*(?:<[^>]+>)?\??\s*\(/gm;
  return Array.from(source.matchAll(functionPattern)).flatMap((match) => {
    const before = source.slice(0, match.index).trimEnd();
    if (before.endsWith('*/')) return [];
    return [source.slice(0, match.index).split('\n').length];
  });
}

describe('role 业务 bundle 架构', () => {
  it.each([
    ['host', './host/rtm.ts'],
    ['audience', './audience/rtm.ts'],
  ])('%s/rtm.ts 只依赖页面级会话 seam 且不引入业务状态模型', (_role, path) => {
    const source = sources[path];

    expect(source, `${path} 应存在`).toBeTypeOf('string');
    expect(runtimeImports(source)).toEqual([]);
    for (const token of BUSINESS_TOKENS) expect(source).not.toContain(token);
    for (const token of REMOVED_MECHANISM_TOKENS) expect(source).not.toContain(token);
    expect(source).not.toContain('RTMEvents');
    expect(source).not.toContain('eventHandlers(');
    expect(source).not.toContain('parseEnvelope(');
    expect(source).not.toContain('acceptedMessages');
  });

  it.each([
    ['host', './host/onRtmEvent.ts'],
    ['audience', './audience/onRtmEvent.ts'],
  ])('%s/onRtmEvent.ts 只绑定事件协议并调用 store listener', (_role, path) => {
    const source = sources[path];

    expect(source, `${path} 应存在`).toBeTypeOf('string');
    expect(source).toContain('bindRtmEvents(');
    expect(source).toContain('this.options.listeners.onPresence(');
    expect(source).toContain('this.options.listeners.onMetadata(');
    expect(source).toContain('this.options.listeners.onMessage(');
    expect(source).toContain('parseEnvelope(');
    for (const name of [
      'handlePresenceSnapshot', 'handleSeatsChanged', 'onSeatRequest',
      'onMemberKicked', 'onChatMessage',
    ]) expect(source).not.toContain(`${name}(`);
  });

  it.each([
    './app-rtm.ts',
    './host/rtm.ts', './audience/rtm.ts',
    './host/onRtmEvent.ts', './audience/onRtmEvent.ts',
  ])('%s 的每个命名函数都说明用途', (path) => {
    expect(uncommentedFunctionLines(sources[path])).toEqual([]);
  });

  it('App RTM 只做应用生命周期登录、监听注册和当前角色事件源切换', () => {
    const source = sources['./app-rtm.ts'];
    expect(source).toContain('bindRtmEvents(');
    expect(source).not.toContain('bindRoomEvents(');
    expect(source).not.toContain('PlatformRtm');
  });

  it('Host/Audience rtm.ts 暴露按功能命名的语义函数', () => {
    const host = sources['./host/rtm.ts'];
    const audience = sources['./audience/rtm.ts'];
    for (const name of [
      'approveSeatRequest', 'rejectSeatRequest', 'inviteToSeat', 'updateSeats',
      'updateAnnouncement', 'kickMember', 'banMember', 'dissolveRoom', 'sendChatMessage',
      'sendGiftMessage', 'sendHeartMessage',
      'muteMicrophone', 'unmuteMicrophone', 'reportMicrophoneError', 'clearMicrophoneError',
      'initializeMemberState',
    ]) expect(host).toContain(`async ${name}(`);
    for (const name of [
      'requestSeat', 'acceptSeatInvitation', 'rejectSeatInvitation',
      'leaveSeat', 'sendChatMessage', 'sendGiftMessage', 'sendHeartMessage',
      'muteMicrophone', 'unmuteMicrophone', 'reportMicrophoneError', 'clearMicrophoneError',
      'clearSeatMediaState',
      'initializeMemberState',
    ]) expect(audience).toContain(`async ${name}(`);
    for (const source of [host, audience]) {
      expect(source).toMatch(/private async setPresenceState\(/);
      expect(source).toMatch(/private async publishToUser\(/);
      expect(source).toMatch(/private async publishToRoom\(/);
    }
    expect(host).toMatch(/private async setRoomMetadata\(/);
  });

  it('Host/Audience rtm.ts 公开函数严格等于映射文档列出的函数', () => {
    expect(publicMethods(sources['./host/rtm.ts'])).toEqual([
      'subscribeRoom', 'unsubscribeRoom', 'initializeRoom', 'clearRoomData', 'updateAnnouncement',
      'updateSeats', 'updateForcedMutedUsers', 'initializeMemberState',
      'muteMicrophone', 'unmuteMicrophone', 'reportMicrophoneError', 'clearMicrophoneError',
      'approveSeatRequest', 'rejectSeatRequest', 'inviteToSeat', 'kickMember',
      'banMember', 'dissolveRoom', 'sendChatMessage', 'sendGiftMessage', 'sendHeartMessage',
      'getTraces', 'subscribeTraces', 'clearTraces',
    ]);
    expect(publicMethods(sources['./audience/rtm.ts'])).toEqual([
      'subscribeRoom', 'unsubscribeRoom', 'initializeMemberState',
      'muteMicrophone', 'unmuteMicrophone', 'reportMicrophoneError', 'clearMicrophoneError',
      'clearSeatMediaState',
      'requestSeat', 'acceptSeatInvitation',
      'rejectSeatInvitation', 'leaveSeat', 'sendChatMessage', 'sendGiftMessage',
      'sendHeartMessage', 'getTraces', 'subscribeTraces', 'clearTraces',
    ]);
  });

  it('nickname store、麦位解析和业务展示摘要只存在于业务桥接层', () => {
    const host = sources['./host/rtm.ts'];
    const audience = sources['./audience/rtm.ts'];
    for (const source of [host, audience]) {
      expect(source).not.toContain('presenceDisplayNames');
      expect(source).not.toContain('presenceSummary(');
      expect(source).not.toContain('storageSummary(');
      expect(source).not.toContain('occupiedSeatsSummary(');
      expect(source).not.toContain('displayName?: string');
    }
    expect(host).not.toContain('metadataWriteSummary(');

    const business = sources['./event-driven-single-room-client.ts'];
    expect(business).toContain('describePresenceEvent(');
    expect(business).toContain('describeRoomMetadata(');
    expect(business).toContain('describeSeats(');
    expect(business).toContain('getNickNameByUid(');
    expect(business).toContain('getMemberDisplayName(');
    expect(business).not.toContain('latest.displayName');
    expect(business).not.toContain('before.displayName');
    expect(business).not.toContain('after.displayName');
  });

  it('当前角色 trace 在页面生命周期内不自动截断或清空', () => {
    for (const source of [sources['./host/rtm.ts'], sources['./audience/rtm.ts']]) {
      expect(source).not.toContain('TRACE_LIMIT');
      expect(source).not.toContain('traces.splice');
      expect(source).not.toMatch(/clearTraces\(\)[\s\S]*?(unsubscribeRoom|subscribeRoom)/);
    }
  });

  it('业务桥接层按事件类型分发到独立消费函数', () => {
    const source = sources['./event-driven-single-room-client.ts'];
    for (const name of [
      'handlePresenceEvent', 'handlePresenceSnapshot', 'onMemberJoined', 'onMemberLeft',
      'onMemberStateChanged', 'handlePresenceInterval', 'handleRoomMetadataChanged',
      'handleSeatsChanged', 'handleAnnouncementChanged', 'handleForcedMutedUsersChanged',
      'handleHostChanged', 'handleMessageEvent', 'onSeatRequest',
      'onSeatInvitationAccepted', 'onSeatInvitationRejected', 'onSeatLeft',
      'onSeatRejected', 'onSeatInvited', 'onMemberKicked', 'onMemberBanned',
      'onChatMessage', 'onGiftMessage', 'onHeartMessage',
      'getNickNameByUid',
    ]) expect(source).toContain(`${name}(`);
    expect(source).not.toContain('onSeatApproved(');
    expect(source).not.toContain('onSeatRequestCancelled(');
  });

  it.each([
    ['host', './host/rtm.ts'],
    ['audience', './audience/rtm.ts'],
  ])('%s/rtm.ts 不维护额外消息频道的本地订阅集合', (_role, path) => {
    expect(sources[path], `${path} 应存在`).not.toMatch(new RegExp(['message', 'Channels'].join('')));
  });

  it.each([
    ['host', './host/rtm.ts'],
    ['audience', './audience/rtm.ts'],
  ])('%s/rtm.ts 订阅房间时不订阅 Lock 事件', (_role, path) => {
    expect(sources[path], `${path} 应存在`).toMatch(/withLock:\s*false/);
  });

  it('当前单角色业务桥接层只通过两个角色 rtm.ts 使用 RTM', () => {
    const source = sources['./event-driven-single-room-client.ts'];
    expect(source).toContain('from "./host/rtm"');
    expect(source).toContain('from "./audience/rtm"');
    expect(source).toContain('from "./host/onRtmEvent"');
    expect(source).toContain('from "./audience/onRtmEvent"');
    expect(source).toContain('consume: () => this.handleMessageEvent(');
    expect(runtimeImports(source)).not.toContain('agora-rtm');
  });

  it('生产页面不再引用同页多客户端 orchestrator 或旧桥接层', () => {
    const source = sources['./VoiceRoomScene.tsx'];
    expect(source).not.toContain('from "./orchestrator"');
    expect(source).not.toContain('VoiceRoomHostClient');
    expect(source).not.toContain('VoiceRoomAudienceClient');
  });

  it('旧 RTM、桥接层与同页双端兼容实现不再存在', () => {
    for (const path of [
      './host/legacy-rtm.ts', './audience/legacy-rtm.ts',
      './host/VoiceRoomHostClient.ts', './audience/VoiceRoomAudienceClient.ts',
      './rtm-host.ts', './rtm-audience.ts', './orchestrator.ts', './single-room-client.ts',
    ]) expect(sources[path]).toBeUndefined();
  });
});
