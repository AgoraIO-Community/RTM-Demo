import { describe, expect, it } from 'vitest';

import { canTransitionInvitation, isTerminalInvitationState, type InvitationState } from '../../invitation/call-state';

describe('主叫与被叫独立状态机', () => {
  it('主叫必须先提交发送成功状态，再接受或拒绝', () => {
    expect(canTransitionInvitation('CALLER', 0, 1)).toBe(true);
    expect(canTransitionInvitation('CALLER', 1, 2)).toBe(true);
    expect(canTransitionInvitation('CALLER', 1, 3)).toBe(false);
    expect(canTransitionInvitation('CALLER', 1, 4)).toBe(false);
    expect(canTransitionInvitation('CALLER', 2, 3)).toBe(true);
    expect(canTransitionInvitation('CALLER', 2, 4)).toBe(true);
  });

  it('被叫发布成功仅进入等待确认，不能跳过12直接接受', () => {
    expect(canTransitionInvitation('CALLEE', 10, 11)).toBe(true);
    expect(canTransitionInvitation('CALLEE', 11, 12)).toBe(true);
    expect(canTransitionInvitation('CALLEE', 11, 13)).toBe(false);
    expect(canTransitionInvitation('CALLEE', 12, 13)).toBe(true);
    expect(canTransitionInvitation('CALLEE', 12, 14)).toBe(false);
    expect(canTransitionInvitation('CALLEE', 12, 15)).toBe(true);
    expect(canTransitionInvitation('CALLEE', 12, 16)).toBe(true);
  });

  it.each([3, 4, 5, 6, 13, 14, 15, 16] as InvitationState[])('终态%s不能回到空闲或变为其他终态', (state) => {
    expect(isTerminalInvitationState(state)).toBe(true);
    for (const target of [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16] as InvitationState[]) {
      expect(canTransitionInvitation(state < 10 ? 'CALLER' : 'CALLEE', state, target)).toBe(false);
    }
  });

  it.each([0, 1, 2, 10, 11, 12] as InvitationState[])('非终态%s允许后续处理且不被当成完成', (state) => {
    expect(isTerminalInvitationState(state)).toBe(false);
  });

  it('角色枚举不能混用，重复状态不伪造变化', () => {
    expect(canTransitionInvitation('CALLER', 10, 11)).toBe(false);
    expect(canTransitionInvitation('CALLEE', 1, 2)).toBe(false);
    expect(canTransitionInvitation('CALLER', 2, 13)).toBe(false);
    expect(canTransitionInvitation('CALLEE', 11, 5)).toBe(false);
    expect(canTransitionInvitation('CALLEE', 11, 11)).toBe(false);
  });
});
