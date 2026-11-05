/**
 * 时间线面板 —— 本 demo 的**核心展示物**。
 *
 * 把每一次 RTM API 调用与每一个 RTM 事件按时间串成一条流水，让读者点一次
 * 「申请上麦」就能看到两端各发生了什么、顺序如何、耗时多少。
 *
 * ## 三条不要「优化」掉的设计
 *
 * **单列交错，不按端分栏。** 两端的条目混在同一列里按时间从新到旧排。分栏会把
 * 「一个动作在两端引发的因果链」拆散，而那正是本 demo 要展示的东西。
 *
 * **只呈现 RTM，不含 RTC。** 混入 RTC 节点会稀释「RTM 数据流」这条主线。
 * RTC 的成败体现为后续那次 RTM 调用的出现或缺席（麦位激活由媒体结果驱动），
 * 因果仍然看得懂。
 *
 * **筛选是纯 UI 过滤。** 被筛掉的条目仍在 store 里，取消筛选即恢复 ——
 * 筛选不动采集、不动环形缓冲的丢弃逻辑。筛选状态是本组件的局部状态。
 *
 * ## 没有「已截断」提示
 *
 * 环形缓冲超限**静默**丢弃最旧的，面板不显示任何截断提示（见票 16 与 spec）。
 *
 * ## 视觉
 *
 * 行左边框与类型标签区分 API 薄荷、EVENT 天蓝；筛选 pill 自带圆点与计数，兼作图例。
 * 颜色全部来自 `styles.css` 的 token，本文件不写颜色字面量。
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PanelIcon } from '../experience/ExperiencePath';
import { filterTraces, type TraceFilter } from './filterTraces';
import { formatTraceTime } from './formatTraceTime';
import { roleColor } from './roleColors';
import type { TraceEntry } from './traceStore';
import { useMergedTraces, type TraceSource } from './useMergedTraces';

/** 两类节点的可访问名。类型只有这两个值；可见文案是等宽的 API / EVENT。 */
const KIND_LABELS: Record<string, string> = {
  api: '调用 RTM API',
  event: '收到 RTM 事件',
};

const NO_FILTER: TraceFilter = {};

/** Keeps high-resolution durations readable without changing the stored value. */
function formatDurationMs(durationMs: number): string {
  const rounded = Math.round(durationMs * 1_000) / 1_000;
  return `${rounded}ms`;
}

export interface TimelinePanelProps {
  /** 各端的 trace 来源。多端顺序不影响结果 —— 归并按时间戳排。 */
  sources: readonly TraceSource[];
  /** 折叠态由外层持有：折叠会改变外壳的栅格列宽。 */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** 某一维筛选是否放行某个值。空集合表示不筛。 */
function isPicked(allowed: readonly string[] | undefined, value: string): boolean {
  return Boolean(allowed?.includes(value));
}

/**
 * 类型筛选 pill。每个 pill 带对应类型的色点与计数，因此不需要单独的图例。
 *
 * 选中项再点一次即取消（回到「全部」），所以不需要单独的「全部」按钮。
 */
function FilterRow({
  options,
  counts,
  picked,
  onToggle,
  testId,
}: {
  options: readonly string[];
  counts: Readonly<Record<string, number>>;
  picked: readonly string[] | undefined;
  onToggle: (value: string) => void;
  testId: string;
}) {
  return (
    <div className="lab-timeline__filters" data-testid={testId}>
      {options.map((option) => {
        const selected = isPicked(picked, option);
        return (
          <button
            key={option}
            type="button"
            className="lab-timeline__filter"
            data-active={selected}
            data-kind={option}
            aria-pressed={selected}
            aria-label={KIND_LABELS[option] ?? option}
            // 再点一次取消 —— 于是「取消筛选后条目全部回来」不需要额外入口。
            onClick={() => onToggle(option)}
          >
            <span className="lab-trace__dot" data-kind={option} aria-hidden="true" />
            {option.toUpperCase()}
            <span className="lab-timeline__filter-count">{counts[option] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 单条时间线条目。行布局是两列网格：时间 86px、正文自适应。 */
function TraceRow({ entry }: { entry: TraceEntry }) {
  const failed = entry.errorCode !== undefined || entry.errorMessage !== undefined;
  const errorDescription = [entry.errorCode, entry.errorMessage]
    .filter((value) => value !== undefined && value !== '')
    .join(' ');
  const fullSummary = [entry.summary, errorDescription].filter(Boolean).join('\n');

  return (
    <li
      className="lab-trace"
      data-kind={entry.kind}
      data-role={entry.role}
      data-failed={failed}
      data-testid="trace-row"
      title={fullSummary || undefined}
    >
      {/* 时间保留时分秒毫秒 —— 便于分辨紧邻的调用。 */}
      <time className="lab-trace__time">{formatTraceTime(entry.at)}</time>

      <div className="lab-trace__body">
        <div className="lab-trace__head">
          <span className="lab-trace__kind">{entry.kind.toUpperCase()}</span>
          <span className="lab-trace__name" title={entry.name}>{entry.name}</span>
          {entry.eventTag && <span className="lab-trace__tag" data-kind="event-type">{entry.eventTag}</span>}
          {/* 保留角色配色来源供现有 trace 数据兼容；UI 通过 CSS 隐藏技术 UID。 */}
          <span
            className="lab-uid-badge"
            data-role={entry.role}
            data-testid="uid-badge"
            style={{
              color: roleColor(entry.role).accent,
              background: roleColor(entry.role).soft,
            }}
          >
            {entry.uid}
          </span>
          {/* 耗时仅 api 条目有。 */}
          {entry.durationMs !== undefined && (
            <span className="lab-trace__duration">{formatDurationMs(entry.durationMs)}</span>
          )}
        </div>
        {(entry.summary || failed) && (
          <div className="lab-trace__summary">
            {entry.summary && <span className="lab-trace__summary-text">{entry.summary}</span>}
            {/* 失败信息在摘要下方独占一行，悬浮同时保留完整诊断内容。 */}
            {failed && <span className="lab-trace__error" data-testid="trace-error">
              {entry.errorCode !== undefined && <code>{entry.errorCode}</code>}
              {entry.errorMessage && <span className="lab-trace__error-message">{entry.errorMessage}</span>}
            </span>}
          </div>
        )}
      </div>
    </li>
  );
}

export function TimelinePanel({
  sources,
  collapsed = false,
  onToggleCollapsed,
}: TimelinePanelProps) {
  // 外部 store 订阅：**API 被调用的瞬间节点就出现**，不轮询、不做整数组 diff。
  const entries = useMergedTraces(sources);
  const [filter, setFilter] = useState<TraceFilter>(NO_FILTER);
  const [showLinkState, setShowLinkState] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 固定两类，首次进入时筛选器即说明颜色；不随过滤结果变化。
  const kinds = ['api', 'event'] as const;
  const visible = useMemo(
    // 归并快照保持时间升序，只反转过滤后生成的展示数组；同毫秒按较大 seq 在前。
    () => filterTraces(entries, filter).filter((entry) => showLinkState || entry.name !== 'linkState').reverse(),
    [entries, filter, showLinkState],
  );
  const counts = useMemo(() => {
    const api = entries.filter((entry) => entry.kind === 'api').length;
    return { api, event: entries.length - api };
  }, [entries]);

  // 新记录、筛选变化或重新展开时，把时间线定位到顶部的最新一项。
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = 0;
  }, [visible, collapsed]);

  /** 多选：已选则移除，未选则加入。 */
  function toggleKind(value: string) {
    setFilter((current) => {
      const kinds = current.kinds ?? [];
      const next = kinds.includes(value)
        ? kinds.filter((item) => item !== value)
        : [...kinds, value];
      return { kinds: next };
    });
  }

  if (collapsed) {
    return (
      <aside className="lab-timeline lab-timeline--collapsed" aria-label="时间线">
        <div className="lab-timeline__collapse-head">
          <button
            type="button"
            className="ink-icon-button"
            data-flipped="true"
            onClick={onToggleCollapsed}
            aria-expanded={false}
            aria-label="展开数据流"
            title="展开数据流"
            data-testid="timeline-toggle"
          >
            <PanelIcon />
          </button>
        </div>
        {/* 折叠态显示条目计数，让人知道里面还在攒东西。 */}
        <div className="lab-timeline__rail">
          <span className="lab-rail-label">RTM 数据流 · <span data-testid="timeline-count">{entries.length}</span></span>
        </div>
        <span />
      </aside>
    );
  }

  return (
    <>
    {/* 窄屏下展开的数据流覆盖主区，点击遮罩收起；桌面端由 CSS 隐藏。 */}
    <button type="button" className="lab-timeline__backdrop" aria-label="收起数据流" onClick={onToggleCollapsed} />
    <aside className="lab-timeline" aria-label="时间线">
      <div className="lab-timeline__header">
        <div className="lab-timeline__heading">
          <span className="lab-timeline__title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12h4l3-8 4 16 3-8h6" />
            </svg>
            RTM 数据流
          </span>
        </div>

        <div className="lab-timeline__actions">
          <button
            type="button"
            className="ink-text-link"
            onClick={() => sources.forEach((source) => source.clear?.())}
            data-testid="timeline-clear"
          >
            清空
          </button>
          <button
            type="button"
            className="ink-text-link"
            onClick={() => setShowLinkState((current) => !current)}
            aria-pressed={showLinkState}
          >
            {showLinkState ? '隐藏连接' : '显示连接'}
          </button>
          <button
            type="button"
            className="ink-icon-button"
            onClick={onToggleCollapsed}
            aria-expanded
            aria-label="折叠数据流"
            title="折叠数据流"
            data-testid="timeline-toggle"
          >
            <PanelIcon />
          </button>
        </div>
      </div>

      {/* 单端房间只需按 API/事件类型筛选；pill 自带色点与计数，兼作图例。 */}
      <FilterRow
        options={kinds}
        counts={counts}
        picked={filter.kinds}
        onToggle={toggleKind}
        testId="filter-kind"
      />

      <div className="lab-timeline__body" ref={bodyRef} data-testid="timeline-body">
        {visible.length === 0 ? (
          <p className="lab-timeline__empty">
            {entries.length === 0
              ? <>RTM 调用与事件将在这里<br />按时间倒序呈现，最新记录在顶部。</>
              : '当前筛选下暂无记录。'}
          </p>
        ) : (
          <ol className="lab-timeline__list">
            {visible.map((entry) => (
              // key 用 role + uid + seq：页面级 login 与角色 trace 可共享同一 uid/seq。
              <TraceRow key={`${entry.sourceId ?? entry.role}:${entry.uid}:${entry.seq}`} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </aside>
    </>
  );
}
