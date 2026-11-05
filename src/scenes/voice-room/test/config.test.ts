import { describe, expect, it } from 'vitest';

import { DEFAULT_ANNOUNCEMENT, SEAT_COUNT } from '../config';

describe('场景配置', () => {
  it('语聊房固定提供八个麦位', () => {
    expect(SEAT_COUNT).toBe(8);
  });

  it('新房间公告默认为空', () => {
    expect(DEFAULT_ANNOUNCEMENT).toBe('');
  });
});
