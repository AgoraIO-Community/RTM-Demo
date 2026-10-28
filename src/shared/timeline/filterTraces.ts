/**
 * 时间线的类型筛选。
 *
 * 筛选是**纯 UI 层过滤**：不影响 trace 采集，不影响环形缓冲的丢弃逻辑。被筛掉的
 * 条目仍然在 store 里，取消筛选即恢复。所以这里是个纯函数，拿到的是只读快照。
 */

import type { TraceEntry } from './traceStore';

/**
 * 筛选条件。空集合表示不筛。
 *
 * 用 `undefined`/空集合表示「全选」，新的同类记录会自动展示。
 */
export interface TraceFilter {
  kinds?: readonly string[];
}

function passes(value: string, allowed: readonly string[] | undefined): boolean {
  // 空集合 = 不筛这一维。
  return !allowed || allowed.length === 0 || allowed.includes(value);
}

/** 纯函数：不改入参，返回新数组。 */
export function filterTraces(
  entries: readonly TraceEntry[],
  filter: TraceFilter,
): TraceEntry[] {
  return entries.filter((entry) => passes(entry.kind, filter.kinds));
}

/** 从条目里收集某一维出现过的全部取值，用于渲染筛选器选项。保持首次出现的顺序。 */
export function collectValues(
  entries: readonly TraceEntry[],
  field: 'kind',
): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    const value = entry[field];
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}
