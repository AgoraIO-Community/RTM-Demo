import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExperiencePath } from './ExperiencePath';
import type { ExperienceScenario } from './types';

const scenario: ExperienceScenario = {
  id: 'voice-room',
  label: '语聊房',
  path: '/social/voice-room',
  description: '语聊房体验',
  status: 'ready',
  steps: [{
    id: 'connect',
    title: '建立房间连接',
    instruction: '填写名称创建房间',
    capability: 'RTM subscribe',
    milestones: [{ id: 'connected', label: '连接完成' }],
  }],
};

afterEach(() => vi.useRealTimers());

describe('ExperiencePath 触屏任务说明', () => {
  it('触摸点击后不被兼容 mouseleave 关闭，失焦后关闭', () => {
    vi.useFakeTimers();
    render(<ExperiencePath scenario={scenario} collapsed={false} onToggle={() => {}} />);
    const step = screen.getByRole('button', { name: '建立房间连接 待体验' });

    fireEvent.pointerDown(step, { pointerType: 'touch' });
    fireEvent.click(step);
    fireEvent.mouseLeave(step);
    act(() => vi.advanceTimersByTime(121));
    expect(screen.getByRole('tooltip')).toHaveTextContent('填写名称创建房间');

    fireEvent.blur(step);
    act(() => vi.advanceTimersByTime(121));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('ExperiencePath 开发资源', () => {
  it('在 API参考下一行提供公开 GitHub 仓库的 Demo 源码链接', () => {
    render(<ExperiencePath scenario={scenario} collapsed={false} onToggle={() => {}} />);

    const apiReference = screen.getByRole('link', { name: 'API参考' });
    const demoSource = screen.getByRole('link', { name: 'Demo 源码' });

    expect(apiReference.nextElementSibling).toBe(demoSource);
    expect(demoSource).toHaveAttribute(
      'href',
      'https://github.com/AgoraIO-Community/RTM-Demo/tree/master/src/scenes/voice-room',
    );
    expect(demoSource).toHaveAttribute('target', '_blank');
    expect(demoSource).toHaveAttribute('rel', 'noreferrer');
  });

  it.each([
    ['one-to-one-call', '/tree/master/src/scenes/one-to-one-call'],
    ['live-commerce', ''],
    [undefined, ''],
  ])('场景 %s 使用对应源码入口', (id, suffix) => {
    render(<MemoryRouter><ExperiencePath scenario={id ? { ...scenario, id } : undefined}
      collapsed={false} onToggle={() => {}} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Demo 源码' })).toHaveAttribute(
      'href', `https://github.com/AgoraIO-Community/RTM-Demo${suffix}`,
    );
  });

});
