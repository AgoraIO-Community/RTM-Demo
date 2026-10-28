import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ExperienceProgress, ExperienceScenario, ExperienceStep } from './types';

const resources = [
  { label: '产品简介', href: 'https://doc.shengwang.cn/doc/rtm2/javascript/landing-page' },
  { label: '最佳实践', href: 'https://doc.shengwang.cn/doc/rtm2/javascript/user-guide/link/link-basic' },
  { label: 'API参考', href: 'https://doc.shengwang.cn/api-ref/rtm2/javascript/toc-configuration/configuration' },
] as const;

/** 面板折叠图标（24 网格、1.75 描边）。折叠态由外层通过 `data-flipped` 水平镜像。 */
export function PanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function StepHelp({ step, children }: { step: ExperienceStep; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touchPinned = useRef(false);
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };
  const hideAfterHover = () => { if (!touchPinned.current) hide(); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open || !button.current || !tooltip.current) return;
    const anchor = button.current.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const left = anchor.right + 10 + box.width <= window.innerWidth - 12
      ? anchor.right + 10 : Math.max(12, anchor.left - box.width - 10);
    setPosition({ left, top: Math.max(12, Math.min(anchor.top, window.innerHeight - box.height - 12)) });
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open]);
  return <>
    <button ref={button} type="button" className="experience-step__button"
      aria-describedby={open ? `experience-help-${step.id}` : undefined}
      onPointerDown={event => { touchPinned.current = event.pointerType !== 'mouse'; }}
      onMouseEnter={show} onMouseLeave={hideAfterHover} onFocus={show}
      onBlur={() => { touchPinned.current = false; hide(); }}
      onClick={show} onKeyDown={event => {
        if (event.key === 'Escape') { touchPinned.current = false; setOpen(false); }
      }}>
      {children}
    </button>
    {open && createPortal(<div ref={tooltip} id={`experience-help-${step.id}`} role="tooltip"
      className="experience-step__tooltip" style={position} onMouseEnter={show} onMouseLeave={hideAfterHover}>
      <p>{step.instruction}</p><span className="experience-step__capability">{step.capability}</span>
    </div>, document.body)}
  </>;
}

/**
 * 左栏「建议体验流程」。只呈现配置与进度，不操作 SDK。
 *
 * 任务只有「已完成 / 待体验」两种状态（设计决定，不做进行中或错误态）。
 * 折叠态由外壳持有：它要改工作区栅格的列宽。
 */
export function ExperiencePath({ scenario, progress, collapsed, onToggle }: {
  scenario?: ExperienceScenario;
  progress?: ExperienceProgress;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const sourceDirectory = scenario?.id === 'voice-room' || scenario?.id === 'one-to-one-call'
    ? `/tree/master/src/scenes/${scenario.id}` : '';
  const sceneResources = [...resources, {
    label: 'Demo 源码', href: `https://github.com/AgoraIO-Community/RTM-Demo${sourceDirectory}`,
  }];
  const steps = scenario?.steps ?? [];
  const evidence = new Set(progress?.scenarioId === scenario?.id ? progress?.milestones : []);
  const completed = steps.filter((step) => step.milestones.length > 0 && step.milestones.every((item) => evidence.has(item.id)));
  const ready = scenario?.status === 'ready';
  const progressLabel = ready ? `${completed.length}/${steps.length}` : '待开放';

  return (
    <>
    {!collapsed && <button type="button" className="experience-path__backdrop" aria-label="收起体验路径" onClick={onToggle} />}
    <aside className="experience-path" aria-label="体验路径" data-collapsed={collapsed}>
      <div className="experience-path__head">
        {!collapsed && <span className="experience-path__title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
            <path d="M9 3v15" />
            <path d="M15 6v15" />
          </svg>
          建议体验流程
        </span>}
        <button type="button" className="ink-icon-button" aria-label="体验路径" aria-expanded={!collapsed}
          aria-controls="experience-path-content" title={collapsed ? '展开' : '折叠'} data-flipped={collapsed}
          onClick={onToggle}>
          <PanelIcon />
        </button>
      </div>
      {collapsed ? (
        <div className="experience-path__rail">
          <span className="lab-rail-label">建议体验流程 · {progressLabel}</span>
        </div>
      ) : (
        <div id="experience-path-content" className="experience-path__content">
          <section className="experience-path__section" aria-labelledby="experience-tasks-title">
            <div className="experience-path__section-title">
              <h2 id="experience-tasks-title">01 / 场景任务</h2>
              <span className="experience-path__count">{progressLabel}</span>
            </div>
            {ready ? <>
              <div className="experience-path__progress" role="progressbar" aria-label="场景任务完成进度"
                aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completed.length}>
                <span style={{ width: `${steps.length ? completed.length / steps.length * 100 : 0}%` }} />
              </div>
              <ol className="experience-path__steps">
                {steps.map((step) => {
                  const done = completed.includes(step);
                  return <li key={`${scenario?.id}-${step.id}`} data-state={done ? 'complete' : 'pending'}>
                    <span className="experience-step__dot" aria-hidden="true" />
                    <StepHelp step={step}>
                      <span className="experience-step__title">{step.title}</span>
                      {' '}
                      <span className="experience-step__status"><CheckIcon />{done ? '已完成' : '待体验'}</span>
                    </StepHelp>
                  </li>;
                })}
              </ol>
            </> : <>
              <p className="experience-path__planned"><span>{scenario?.label ?? '当前场景'}的体验任务正在准备中。</span>先到语聊房完成一次真实互动。</p>
              <Link className="experience-path__planned-link" to="/social/voice-room" reloadDocument>前往语聊房<span className="experience-path__arrow" aria-hidden="true">→</span></Link>
            </>}
          </section>
          <section className="experience-path__section" aria-labelledby="experience-console-title">
            <div className="experience-path__section-title"><h2 id="experience-console-title">02 / 开始构建</h2></div>
            <a className="experience-path__console" href="https://console.shengwang.cn/" target="_blank" rel="noreferrer">
              前往 Console 创建项目<span className="experience-path__arrow" aria-hidden="true">↗</span>
            </a>
          </section>
          <section className="experience-path__section" aria-labelledby="experience-docs-title">
            <div className="experience-path__section-title"><h2 id="experience-docs-title">03 / 开发文档</h2></div>
            <div className="experience-path__resources">
              {sceneResources.map(({ label, href }) => <a key={label} href={href} target="_blank" rel="noreferrer" aria-label={label}>
                {label}<span className="experience-path__arrow" aria-hidden="true">↗</span>
              </a>)}
            </div>
          </section>
        </div>
      )}
    </aside>
    </>
  );
}
