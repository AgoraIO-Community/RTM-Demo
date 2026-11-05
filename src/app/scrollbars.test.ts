import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindScrollbarActivity } from './scrollbars';

let dispose: (() => void) | undefined;

function scrollport() {
  const element = document.createElement('div');
  element.style.overflow = 'auto';
  element.style.overflowY = 'auto';
  element.style.overflowX = 'auto';
  element.tabIndex = 0;
  element.innerHTML = '<button>First</button><button>Second</button>';
  Object.defineProperties(element, {
    clientHeight: { value: 100 }, scrollHeight: { value: 500 },
    clientWidth: { value: 200 }, scrollWidth: { value: 200 },
  });
  document.body.append(element);
  return element;
}

function enter(target: Element, relatedTarget: EventTarget | null = null) {
  target.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget }));
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('全站滚动条活动', () => {
  it('移入后短暂显示，鼠标不离开也会隐藏', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    enter(element);
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(700);
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(200);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('在同一个组件的子元素间移动，不重置隐藏倒计时', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    enter(element.firstElementChild!);
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(600);
    enter(element.lastElementChild!, element.firstElementChild);
    vi.advanceTimersByTime(300);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('每次滚动重置倒计时，停止滚动后隐藏', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    element.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(600);
    element.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(600);
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(300);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('键盘焦点进入后短暂显示，保留焦点不会持续显示', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    element.focus();
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(900);
    expect(document.activeElement).toBe(element);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('滚轮到达边界时也能短暂显示，但不显示被刻意隐藏的导航滚动条', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));
    expect(element).toHaveAttribute('data-scrollbar-active');
    vi.advanceTimersByTime(900);
    element.style.scrollbarWidth = 'none';
    enter(element);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('拖动滚动条时保持显示，松开后再隐藏', () => {
    vi.useFakeTimers();
    const element = scrollport();
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 206, 100));
    dispose = bindScrollbarActivity();
    const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 203, clientY: 30 });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    element.dispatchEvent(down);
    vi.advanceTimersByTime(2500);
    expect(element).toHaveAttribute('data-scrollbar-active');
    const up = new MouseEvent('pointerup', { bubbles: true });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    document.dispatchEvent(up);
    vi.advanceTimersByTime(900);
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('清理移除状态、定时器和事件，重复清理安全', () => {
    vi.useFakeTimers();
    const element = scrollport();
    dispose = bindScrollbarActivity();
    enter(element);
    expect(element).toHaveAttribute('data-scrollbar-active');
    dispose();
    dispose();
    expect(element).not.toHaveAttribute('data-scrollbar-active');
    enter(element);
    element.dispatchEvent(new Event('scroll'));
    vi.runAllTimers();
    expect(element).not.toHaveAttribute('data-scrollbar-active');
  });

  it('嵌套滚动区域的触屏操作结束后，不遗留持续显示的滚动条', () => {
    vi.useFakeTimers();
    const outer = scrollport();
    const inner = scrollport();
    outer.append(inner);
    dispose = bindScrollbarActivity();
    const down = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperties(down, { pointerId: { value: 1 }, pointerType: { value: 'touch' } });
    inner.dispatchEvent(down);
    expect(inner).toHaveAttribute('data-scrollbar-active');
    const up = new MouseEvent('pointerup', { bubbles: true });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    document.dispatchEvent(up);
    vi.advanceTimersByTime(900);
    expect(inner).not.toHaveAttribute('data-scrollbar-active');
    expect(outer).not.toHaveAttribute('data-scrollbar-active');
  });
});
