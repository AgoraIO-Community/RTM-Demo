/**
 * 多实例 trace 归并。
 *
 * 一个标签页里跑多个真实客户端（语聊房是房主 + 听众两端，课堂是三端），
 * 每端各自持有一份 trace。时间线要把它们合成一条流水，因此需要一个纯函数把
 * 若干份快照按时间归并。
 *
 * 排序规则：`at`（时间戳）是主键，同毫秒时用 `seq`（实例内单调递增序号）作
 * 稳定次序 —— 这保证同一实例内的调用顺序在归并后不会错乱，即使多端在同一
 * 毫秒里各发生了好几次调用。
 *
 * 归并只重排、不改写条目：每条仍带自己的 `uid` 与 `role`，**来源不能丢**。
 */

import type { TraceEntry } from './traceStore';

/**
 * 把多份 trace 快照归并成一条时间线。
 *
 * 纯函数：不改写入参数组，返回新数组。
 */
export function mergeTraces(lists: readonly (readonly TraceEntry[])[]): TraceEntry[] {
  return lists
    .flat()
    .slice()
    .sort((left, right) => left.at - right.at || left.seq - right.seq);
}
