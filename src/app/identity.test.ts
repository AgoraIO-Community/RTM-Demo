import { beforeEach, describe, expect, it } from 'vitest';

import { deriveIdentity } from './identity';

/** 可预测的随机段序列，让断言能盯住结构而不是具体值。 */
function sequence(...segments: string[]): () => string {
  let index = 0;
  return () => segments[index++] ?? `overflow-${index}`;
}

describe('deriveIdentity', () => {
  it('无 URL 参数时房间号与各端 uid 全部自动生成', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      randomSegment: sequence('r00m01', 'aaa111', 'bbb222'),
    });

    expect(identity.roomId).toBe('voice-room-r00m01');
    expect(identity.uids).toEqual({ host: 'host-aaa111', audience: 'audience-bbb222' });
  });

  it('uid 带角色前缀，时间线的 uid badge 依赖它做可读区分', () => {
    const identity = deriveIdentity({
      sceneId: 'classroom',
      roles: ['teacher', 'student', 'assistant'],
      randomSegment: sequence('r00m01', 'aaa111', 'bbb222', 'ccc333'),
    });

    expect(identity.uids.teacher.startsWith('teacher-')).toBe(true);
    expect(identity.uids.student.startsWith('student-')).toBe(true);
    expect(identity.uids.assistant.startsWith('assistant-')).toBe(true);
  });

  it('同一标签页内各端 uid 互不相同，靠前缀加各自独立随机段保证', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      // 刻意让两端抽到同一个随机段：前缀不同就足以保证不撞，不需要冲突检测
      randomSegment: () => 'same00',
    });

    const uids = Object.values(identity.uids);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('默认随机生成的房间号形如「场景名 + 6 位 base36」', () => {
    const identity = deriveIdentity({ sceneId: 'voice-room', roles: ['host'] });

    expect(identity.roomId).toMatch(/^voice-room-[0-9a-z]{6}$/);
    expect(identity.uids.host).toMatch(/^host-[0-9a-z]{6}$/);
  });

  it('?room= 覆盖房间号，用于两人对连同一个房间做真实联调', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?room=demo-42',
      // 只有真正需要生成的槽位才消耗随机段：房间号被覆盖，所以序列从 host 开始
      randomSegment: sequence('aaa111', 'bbb222'),
    });

    expect(identity.roomId).toBe('demo-42');
    // 房间号被覆盖不影响 uid 仍然自动生成
    expect(identity.uids).toEqual({ host: 'host-aaa111', audience: 'audience-bbb222' });
  });

  it('?uid.<role>= 覆盖指定角色的 uid，其余角色仍自动生成', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?uid.host=host-alice',
      randomSegment: sequence('r00m01', 'bbb222'),
    });

    expect(identity.uids.host).toBe('host-alice');
    expect(identity.uids.audience).toBe('audience-bbb222');
  });

  it('?uid= 是主角色（roles 第一项）的简写', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?uid=host-alice',
      randomSegment: sequence('r00m01', 'bbb222'),
    });

    expect(identity.uids.host).toBe('host-alice');
    expect(identity.uids.audience).toBe('audience-bbb222');
  });

  it('覆盖值缺少角色前缀时补齐，保证 uid badge 的前缀不变式', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?uid.host=alice&uid.audience=audience-bob',
      randomSegment: sequence('r00m01'),
    });

    expect(identity.uids.host).toBe('host-alice');
    // 已带前缀的不重复补，保持幂等
    expect(identity.uids.audience).toBe('audience-bob');
  });

  it('只有裸角色前缀、没有主体的覆盖值被忽略，回落到自动生成', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      // `host-` 满足前缀不变式却没有任何区分度：两端各写一次就撞成同一个 uid，
      // 而我们刻意不做冲突检测，所以必须在这里拒掉
      search: '?uid.host=host-&uid.audience=-',
      randomSegment: sequence('r00m01', 'aaa111', 'bbb222'),
    });

    expect(identity.uids.host).toBe('host-aaa111');
    expect(identity.uids.audience).toBe('audience-bbb222');
  });

  it('空白或空的覆盖值被忽略，回落到自动生成', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host'],
      search: '?room=%20%20&uid=%20%20',
      randomSegment: sequence('r00m01', 'aaa111'),
    });

    expect(identity.roomId).toBe('voice-room-r00m01');
    expect(identity.uids.host).toBe('host-aaa111');
  });

  it('未知角色的 uid 参数被忽略，不会凭空多出一个端', () => {
    const identity = deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?uid.ghost=ghost-x',
      randomSegment: sequence('r00m01', 'aaa111', 'bbb222'),
    });

    expect(Object.keys(identity.uids)).toEqual(['host', 'audience']);
  });
});

describe('deriveIdentity 不落 storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('推导结果与 URL 覆盖值都不写入任何 storage，每次刷新重新推导', () => {
    deriveIdentity({
      sceneId: 'voice-room',
      roles: ['host', 'audience'],
      search: '?room=demo-42&uid.host=host-alice',
    });

    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
