/**
 * 已规划场景的统一占位页。
 *
 * 一个组件服务全部已规划场景，**不给每个场景单独写文案** —— 只有标题与摘要
 * 来自注册表，其余引导文案共用。tab 可见可点、进来是路线图而不是灰置的死路，
 * 这是「让客户看见 RTM 能覆盖多少场景」的展示目的（见 spec「场景注册表」）。
 */

import { Link } from 'react-router-dom';

import { capabilitiesOf, type RtmCapability } from '../scenes/capabilities';
import type { SceneEntry } from '../scenes/registry';

interface ScenePlaceholderProps {
  scene: SceneEntry;
}

/** 能力标签对应的 RTM primitive，作为行右侧的等宽元信息。 */
export const CAPABILITY_APIS: Record<RtmCapability, string> = {
  用户消息: 'publish · USER',
  消息频道: 'publish · MESSAGE',
  Presence: 'presence · setState',
  Storage: 'storage · setChannelMetadata',
  Lock: 'lock · acquireLock',
};

export function ScenePlaceholder({ scene }: ScenePlaceholderProps) {
  const capabilities = capabilitiesOf(scene.id);

  return (
    <section className="lab-placeholder" data-testid="scene-placeholder">
      <div className="lab-placeholder__inner">
        <div className="lab-placeholder__intro">
          <p className="lab-placeholder__badge ink-eyebrow">ROADMAP<span className="ink-tag--dashed">尚未构建</span></p>
          <h1 className="lab-placeholder__title">{scene.title}</h1>
          <p className="lab-placeholder__summary">{scene.summary}</p>
        </div>
        {/*
          「计划演示哪些 RTM 能力」是票 15 与 spec 的明确要求。能力标签不进注册表
          （四字段护栏），单独住在 `scenes/capabilities.ts`。
        */}
        <div className="lab-placeholder__capabilities">
          <span className="lab-placeholder__capabilities-label">计划演示的 RTM 能力</span>
          <ul className="lab-placeholder__capability-list">
            {capabilities.map((capability) => (
              <li key={capability} className="lab-placeholder__capability">
                <span>{capability}</span>
                <span aria-hidden="true">{CAPABILITY_APIS[capability]}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="lab-placeholder__note">
          实验室先把它列出来，是为了说明 RTM 能覆盖到这里。想先看真实链路，请前往{' '}
          <Link to="/social/voice-room" reloadDocument>语聊房</Link>
          {' '}—— 体验房间互动；每个标签页运行一个真实角色客户端。
        </p>
      </div>
    </section>
  );
}
