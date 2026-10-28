import { describe, expect, it } from 'vitest';

import { sceneCapabilities, capabilitiesOf } from './capabilities';
import { allScenes } from './registry';

describe('场景能力标签', () => {
  it('不进注册表但不丢弃 —— 每个场景都有能力标签', () => {
    for (const scene of allScenes) {
      expect(capabilitiesOf(scene.id).length).toBeGreaterThan(0);
    }
  });

  it('标签取值只有这五个，不得出现别的能力名', () => {
    const allowed = new Set(['用户消息', '消息频道', 'Presence', 'Storage', 'Lock']);

    for (const capabilities of Object.values(sceneCapabilities)) {
      for (const capability of capabilities) {
        expect(allowed.has(capability)).toBe(true);
      }
    }
  });

  it('只登记注册表里存在的场景 id —— 改名后不留孤儿条目', () => {
    const knownIds = new Set(allScenes.map((scene) => scene.id));

    for (const sceneId of Object.keys(sceneCapabilities)) {
      expect(knownIds.has(sceneId)).toBe(true);
    }
  });

  it('语聊房同时覆盖礼物弹幕与上下麦，所以含 Lock', () => {
    expect(capabilitiesOf('voice-room')).toEqual(
      expect.arrayContaining(['消息频道', 'Storage', 'Lock']),
    );
  });

  it('未知场景 id 返回空数组，不抛异常', () => {
    expect(capabilitiesOf('no-such-scene')).toEqual([]);
  });

  it('返回的数组被改写不影响登记表', () => {
    const first = capabilitiesOf('voice-room');
    (first as string[]).length = 0;

    expect(capabilitiesOf('voice-room').length).toBeGreaterThan(0);
  });
});
