/**
 * 单实例 trace 采集容器。
 *
 * **这份实现放在共享目录只是为了给测试、归并模块和视图层提供类型与参考实现。**
 * 两份可拷走的 `rtm-<role>.ts` 各自内联自己的 store 实现，不 import 本文件 ——
 * 这不是重复的疏漏，是零依赖的代价（见票 16 与 spec「角色 RTM 单文件的契约」）。
 *
 * 导出为可订阅对象而非裸数组：时间线是本 demo 的核心展示物，「API 被调用的瞬间
 * 节点就出现」值得这点订阅样板，视图层配标准的外部 store 订阅钩子即可，
 * 无需轮询与整数组 diff。
 */

/** 环形上限。模块常量 —— 客户拷走后可自行调整。 */
export const TRACE_LIMIT = 500;

/**
 * 静默吞掉所有写入的 Proxy handler。
 *
 * 用 Proxy 而不是 `Object.freeze`：冻结对象在严格模式下会让调用方的赋值抛
 * `TypeError`，而这里要的语义是「改写无效」，不是「改写报错」。
 * 返回 `true` 是必须的 —— 返回 `false` 同样会触发 `TypeError`。
 */
/**
 * 静默忽略一切写入的 Proxy handler。
 *
 * 泛型是必需的：写成 `ProxyHandler<object>` 会让 `new Proxy(arr, h)` 的返回类型
 * 退化成 `object`，调用方就拿不到数组类型了。
 */
function ignoreWrites<T extends object>(): ProxyHandler<T> {
  return {
    // 三个陷阱都返回 true（「已处理」）而不是 false —— 返回 false 会让严格模式
    // 下的赋值抛 TypeError，而这里要的是「改写无效」，不是「改写报错」。
    set: () => true,
    deleteProperty: () => true,
    defineProperty: () => true,
  };
}

/**
 * 条目类型只有两个值：调 RTM API 出一个 `api` 节点，收到 RTM 事件出一个 `event` 节点。
 *
 * RTC 层不采集 trace —— 混入 RTC 节点会稀释「RTM 数据流」这条主线。
 */
export type TraceKind = 'api' | 'event';

/** 写入时提供的字段。`seq` / `uid` / `role` 由 store 自己补。 */
export interface TraceInput {
  /** 时间戳，归并的主排序键。 */
  at: number;
  kind: TraceKind;
  /** API 方法名或事件名。 */
  name: string;
  /** SDK 事件类型，或 publish API 的 `USER` / `MESSAGE` 类型。 */
  eventTag?: string;
  /** 短摘要，**不放完整对象** —— 时间线只呈现可读要点。 */
  summary?: string;
  /** 耗时，仅 api 条目有。 */
  durationMs?: number;
  /** 错误码，仅 api 条目有。 */
  errorCode?: number;
  /** 错误信息，仅 api 条目有。 */
  errorMessage?: string;
}

export interface TraceEntry extends TraceInput {
  /** Stable presentation identity when one page retains several sources for the same role. */
  sourceId?: string;
  /** 实例内单调递增序号。归并时作同毫秒的稳定次序。 */
  seq: number;
  /** 由实例自己贴，不由业务层读取时补 —— 归并后来源不能丢。 */
  uid: string;
  /** 同上。 */
  role: string;
}

export interface TraceStoreOptions {
  uid: string;
  role: string;
  /** 环形上限。默认 `TRACE_LIMIT`，留参数位便于测试与场景微调。 */
  limit?: number;
}

export interface TraceStore {
  record(input: TraceInput): number;
  update(seq: number, patch: Pick<TraceInput, 'summary'>): void;
  /** 只读快照。业务层改写返回的数组不影响内部状态。 */
  getEntries(): readonly TraceEntry[];
  /** 返回退订函数。 */
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export function createTraceStore({ uid, role, limit = TRACE_LIMIT }: TraceStoreOptions): TraceStore {
  const entries: TraceEntry[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;

  /**
   * 记忆化的快照。写入后置空，下次 `getEntries()` 重建。
   *
   * 未变时返回同一个引用是 `useSyncExternalStore` 的硬要求 —— 每次都新建数组
   * 会让它判定「变了」而无限重渲染。
   */
  let snapshot: readonly TraceEntry[] | undefined;

  /**
   * 造一份对外的只读快照。
   *
   * 两件事一起做，少任何一件内部状态都会被打穿：
   * 1. **元素逐个复制** —— 直接 `[...entries]` 是浅拷贝，元素对象仍共享引用，
   *    `getEntries()[0].name = 'x'` 会改到内部条目。
   * 2. **Proxy 拦下数组级写入** —— `push` / `length = 0` / `[0] = x` 全部静默忽略。
   *    用 Proxy 而不是 `Object.freeze`：冻结数组在严格模式下会让调用方的赋值抛
   *    `TypeError`，而这里要的是「改写无效」，不是「改写报错」。
   */
  function createSnapshot(): readonly TraceEntry[] {
    // 条目也各包一层：只复制不拦写的话，调用方改写元素属性会污染这份缓存，
    // 而缓存会被后续每次 `getEntries()` 持续返回（内部 `entries` 虽然干净，
    // 对外可观察的输出已经错了）。
    const copy = entries.map((entry) => new Proxy({ ...entry }, ignoreWrites<TraceEntry>()));
    return new Proxy(copy, ignoreWrites<TraceEntry[]>());
  }

  function notify(): void {
    snapshot = undefined;
    for (const listener of listeners) listener();
  }

  return {
    record(input) {
      seq += 1;
      entries.push({ ...input, seq, uid, role });
      // 超限静默丢弃最旧的：不插入任何「已截断」标记条目。
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      notify();
      return seq;
    },

    update(targetSeq, patch) {
      const entry = entries.find((candidate) => candidate.seq === targetSeq);
      if (!entry) return;
      Object.assign(entry, patch);
      notify();
    },

    getEntries() {
      // 写入路径经 `notify()` 把 snapshot 置空，所以这里只需判「有没有缓存」。
      snapshot ??= createSnapshot();
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear() {
      entries.length = 0;
      notify();
    },
  };
}
