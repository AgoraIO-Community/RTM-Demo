/** Reveal native scrollbar thumbs briefly after activity, without changing scroll ownership. */
export function bindScrollbarActivity(doc: Document = document): () => void {
  const active = new Map<HTMLElement, ReturnType<typeof setTimeout> | undefined>();
  const dragging = new Map<number, HTMLElement>();
  let disposed = false;

  const scrollable = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    if (style.scrollbarWidth === 'none') return false;
    const root = element === doc.scrollingElement;
    return (element.scrollHeight > element.clientHeight && (root || /auto|scroll|overlay/.test(style.overflowY || style.overflow)))
      || (element.scrollWidth > element.clientWidth && (root || /auto|scroll|overlay/.test(style.overflowX || style.overflow)));
  };
  const ancestors = (target: EventTarget | null, visit: (element: HTMLElement) => void) => {
    let element = target instanceof Element ? target : target === doc ? doc.scrollingElement : null;
    for (; element; element = element.parentElement) {
      if (element instanceof HTMLElement && scrollable(element)) visit(element);
    }
  };
  const reveal = (element: HTMLElement) => {
    if (disposed) return;
    clearTimeout(active.get(element));
    element.setAttribute('data-scrollbar-active', '');
    if ([...dragging.values()].includes(element)) {
      active.set(element, undefined);
    } else {
      active.set(element, setTimeout(() => {
        element.removeAttribute('data-scrollbar-active');
        active.delete(element);
      }, 800));
    }
  };
  const onEnter = (event: PointerEvent) => ancestors(event.target, element => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) reveal(element);
  });
  const onIntent = (event: Event) => ancestors(event.target, reveal);
  const onScroll = (event: Event) => {
    const element = event.target === doc ? doc.scrollingElement : event.target;
    if (element instanceof HTMLElement && scrollable(element)) reveal(element);
  };
  const onPress = (event: PointerEvent) => {
    let claimed = false;
    ancestors(event.target, element => {
      if (claimed) return;
      const box = element.getBoundingClientRect();
      const vertical = element.scrollHeight > element.clientHeight && event.clientX >= box.left + element.clientLeft + element.clientWidth;
      const horizontal = element.scrollWidth > element.clientWidth && event.clientY >= box.top + element.clientTop + element.clientHeight;
      if (event.pointerType === 'touch' || vertical || horizontal) {
        claimed = true;
        dragging.set(event.pointerId, element);
        reveal(element);
      }
    });
  };
  const onRelease = (event: PointerEvent) => {
    const element = dragging.get(event.pointerId);
    if (!element) return;
    dragging.delete(event.pointerId);
    reveal(element);
  };
  const onBlur = () => {
    const elements = new Set(dragging.values());
    dragging.clear();
    elements.forEach(reveal);
  };

  doc.addEventListener('pointerover', onEnter, { capture: true, passive: true });
  doc.addEventListener('wheel', onIntent, { capture: true, passive: true });
  doc.addEventListener('focusin', onIntent, true);
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPress, { capture: true, passive: true });
  doc.addEventListener('pointerup', onRelease, true);
  doc.addEventListener('pointercancel', onRelease, true);
  doc.defaultView?.addEventListener('blur', onBlur);

  return () => {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener('pointerover', onEnter, true);
    doc.removeEventListener('wheel', onIntent, true);
    doc.removeEventListener('focusin', onIntent, true);
    doc.removeEventListener('scroll', onScroll, true);
    doc.removeEventListener('pointerdown', onPress, true);
    doc.removeEventListener('pointerup', onRelease, true);
    doc.removeEventListener('pointercancel', onRelease, true);
    doc.defaultView?.removeEventListener('blur', onBlur);
    for (const [element, timer] of active) {
      clearTimeout(timer);
      element.removeAttribute('data-scrollbar-active');
    }
    active.clear();
    dragging.clear();
  };
}
