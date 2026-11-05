/**
 * 多实例 trace 的订阅钩子。
 *
 * 票 20 要求**用外部 store 订阅机制接入 trace，不轮询**。这里用 React 官方的
 * `useSyncExternalStore`，它对 `getSnapshot` 有一条硬要求：**未变化时必须返回同一
 * 引用**，否则会判定「变了」而无限重渲染。
 *
 * 而 `mergeTraces()` 每次调用都会新建数组，直接喂进去必然死循环。所以这里加一层
 * 记忆化：只有当某个 source 的快照引用真的变了，才重新归并。各 source 自己的
 * `getEntries()` 已经保证「未变时返回同一引用」（见 `traceStore` 与两份 RTM 单文件）。
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

import { mergeTraces } from './mergeTraces';
import type { TraceEntry } from './traceStore';

/**
 * 一个 trace 来源。
 *
 * 形状刻意最小化，让 `traceStore` 与两份 RTM 单文件内联的 store 都能直接适配 ——
 * 面板不关心条目是谁采集的。
 */
export interface TraceSource {
  getEntries(): readonly TraceEntry[];
  subscribe(listener: () => void): () => void;
  /**
   * 清空本端条目。可选 —— 面板的「清空」按钮会对每个 source 调一次。
   *
   * 做成可选是因为归并与筛选都只需要读；不支持清空的来源（比如一份静态快照）
   * 也应该能喂进面板。
   */
  clear?(): void;
}

export function useMergedTraces(sources: readonly TraceSource[]): readonly TraceEntry[] {
  /** 上一次归并的输入与输出，用于判断能否复用。 */
  const cache = useRef<{
    inputs: readonly (readonly TraceEntry[])[];
    output: readonly TraceEntry[];
  }>({ inputs: [], output: [] });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribes = sources.map((source) => source.subscribe(onStoreChange));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    [sources],
  );

  const getSnapshot = useCallback(() => {
    const inputs = sources.map((source) => source.getEntries());
    const { inputs: prev, output } = cache.current;
    // 逐个比引用：全部没变就复用上次的归并结果，满足同一引用的要求。
    const unchanged =
      prev.length === inputs.length && inputs.every((entries, index) => entries === prev[index]);
    if (unchanged) return output;

    const merged = mergeTraces(inputs);
    // 第二道闸：输入数组换了引用但内容其实一样时，仍然返回上一次的结果。
    // 上面那道只比数组引用，遇到「每次调用都新建数组」的来源（静态快照、
    // 测试替身，或将来某个忘了记忆化的实现）会判定「变了」而无限重渲染。
    // 条目对象本身是稳定引用，所以逐元素比引用足够便宜也足够准。
    if (merged.length === output.length && merged.every((entry, index) => entry === output[index])) {
      // 输入引用照旧存下来，让下一次能命中上面那道更快的闸。
      cache.current = { inputs, output };
      return output;
    }

    cache.current = { inputs, output: merged };
    return merged;
  }, [sources]);

  // 服务端快照用同一个实现：本 demo 不做 SSR，但参数是必需的。
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 把任意「有 getTraces / subscribeTraces」的对象适配成 `TraceSource`。
 *
 * 两份 RTM 单文件各自内联了自己的 trace store（零依赖的代价），导出的方法名是
 * `getTraces` / `subscribeTraces` / `clearTraces`；本函数负责这层改名，
 * **不要为此去改 RTM 单文件的方法名** —— 那是客户要拷走的文件，命名以它为准。
 */
export function toTraceSource(client: {
  getTraces(): readonly TraceEntry[];
  subscribeTraces(listener: () => void): () => void;
  clearTraces?(): void;
}): TraceSource {
  return {
    getEntries: () => client.getTraces(),
    subscribe: (listener) => client.subscribeTraces(listener),
    clear: client.clearTraces ? () => client.clearTraces?.() : undefined,
  };
}

/** 稳定化 source 数组，避免调用方每次渲染都新建数组导致重订阅。 */
export function useTraceSources(sources: readonly TraceSource[]): readonly TraceSource[] {
  // 依赖是展开后的各个 source —— 数组字面量每次都是新引用，但元素通常稳定。
  return useMemo(() => sources, sources);
}
