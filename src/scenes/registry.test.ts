import { describe, expect, it } from 'vitest';

import { findCategory, findScene, sceneCategories, allScenes } from './registry';

/** 注册表允许的字段。多一个都算越界 —— 这是本票的核心护栏。 */
const ALLOWED_SCENE_KEYS = ['id', 'status', 'summary', 'title'];

describe('场景注册表', () => {
  it('8 个一级分类齐全，顺序与 spec 一致', () => {
    expect(sceneCategories.map((category) => category.id)).toEqual([
      'social',
      'education',
      'enterprise',
      'iot',
      'content',
      'healthcare',
      'mobility',
      'gaming',
    ]);
  });

  it('二级条目共 23 个', () => {
    expect(allScenes).toHaveLength(23);
  });

  it('二级条目只有 id/title/summary/status 四个字段', () => {
    for (const scene of allScenes) {
      // 这道护栏防的是「服务于一套通用 UI 数据驱动渲染」的字段被加进来：
      // canvas、roles、actions、initialStatus、supportsRealRtm 等一律不得出现。
      expect(Object.keys(scene).sort()).toEqual(ALLOWED_SCENE_KEYS);
    }
  });

  it('status 只有 ready 与 planned 两个值，不存在「进行中」', () => {
    const statuses = new Set(allScenes.map((scene) => scene.status));

    expect([...statuses].sort()).toEqual(['planned', 'ready']);
  });

  it('语聊房和 1V1 呼叫邀请已实现，均归社交分类', () => {
    const ready = allScenes.filter((scene) => scene.status === 'ready');

    expect(ready.map((scene) => scene.id)).toEqual(['voice-room', 'one-to-one-call']);
    expect(findCategory('social')?.scenes.some((scene) => scene.id === 'voice-room')).toBe(true);
    expect(findCategory('social')?.scenes.some((scene) => scene.id === 'one-to-one-call')).toBe(true);
  });

  it('场景 id 不带一级分类前缀 —— id 出现在 URL 里应当稳定', () => {
    const categoryIds = sceneCategories.map((category) => category.id);

    for (const scene of allScenes) {
      for (const categoryId of categoryIds) {
        expect(scene.id.startsWith(`${categoryId}-`)).toBe(false);
      }
    }
  });

  it('场景 id 全局唯一', () => {
    const ids = allScenes.map((scene) => scene.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个场景都有非空标题与一句话摘要', () => {
    for (const scene of allScenes) {
      expect(scene.title.trim().length).toBeGreaterThan(0);
      expect(scene.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('每个分类至少有一个场景', () => {
    for (const category of sceneCategories) {
      expect(category.scenes.length).toBeGreaterThan(0);
    }
  });

  it('分类同时有完整 label 与窄屏用的 shortLabel', () => {
    for (const category of sceneCategories) {
      expect(category.label.trim().length).toBeGreaterThan(0);
      expect(category.shortLabel.trim().length).toBeGreaterThan(0);
      // shortLabel 是窄屏兜底，不该比完整 label 更长
      expect(category.shortLabel.length).toBeLessThanOrEqual(category.label.length);
    }
  });

  it('allScenes 是各分类场景的扁平展开，顺序一致', () => {
    expect(allScenes).toEqual(sceneCategories.flatMap((category) => category.scenes));
  });
});

describe('查找', () => {
  it('findScene 按 id 找到场景', () => {
    expect(findScene('voice-room')?.title).toBeTruthy();
  });

  it('findScene 对未知 id 返回 undefined，不抛异常', () => {
    expect(findScene('no-such-scene')).toBeUndefined();
  });

  it('findCategory 按 id 找到分类，未知 id 返回 undefined', () => {
    expect(findCategory('social')?.label).toBeTruthy();
    expect(findCategory('no-such-category')).toBeUndefined();
  });
});
