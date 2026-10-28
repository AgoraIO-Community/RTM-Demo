# 1V1 呼叫邀请功能与 RTM 函数映射

更新日期：2026-10-19

呼叫邀请通过 RTM `USER` 消息协作，处理发起、接听、拒绝、取消与过期。每次邀请有独立实例，接受后由 App 建立和管理音频。模块划分见[模块与依赖关系](./1v1呼叫邀请模块与依赖关系.md)，完整状态图见[状态流转与时序](./1v1呼叫邀请状态流转与时序.md)，验证步骤见[端到端回归流程](./1v1呼叫邀请端到端回归流程.md)。

## 1. 两种接入路径

邀请实现集中在 [invitation/](../invitation/index.ts)，包含 index.ts、call-controller.ts、call-invitation.ts、call-state.ts、call-protocol.ts 和 call-errors.ts。整个目录可以复制到已有 RTM SDK 的 App，不依赖 React、RTC、Demo 场景代码或 SDK 登录封装。

### 1.1 Demo：App 通过 CallRtm 操作邀请

```text
OneToOneCallScene / AppCallController
  → 场景 rtm.ts / CallRtm
    → invitation/index.ts / Invitation
      → AppCallRtmSession 的 RTM 调用适配
        → 已登录的 RTM Client 实例
          → RTM USER

SDK message/linkState
  → AppCallRtmSession / 场景事件绑定
    → CallRtm.handleMessage / handleLinkStateChange
```

[rtm.ts](../rtm.ts) 是 Demo 的信令业务入口。`AppCallRtmSession` 持有页面唯一的已登录 RTM Client 实例，负责 login、事件和 trace，并通过 `getCallPort()` 提供发布调用适配。适配沿用同一 Client，并记录真实 API trace。`CallRtm` 包装邀请插件；App 通过场景业务函数操作邀请。

```ts
import { CallRtm } from '../rtm';

const rtm = new CallRtm({
  userId,
  session,
  invitationOptions: {
    callerInvitationExpireMs: 30_000,
    calleeInvitationExpireMs: 30_000,
  },
});

const outgoing = rtm.createOutgoingInvitation(targetUid, 'app-defined-data');
outgoing.subscribe(() => renderInvitation(outgoing.getSnapshot()));
await rtm.sendCallInvitation(outgoing.callId);
```

`session` 提供 `getCallPort()` 和 `getCurrentLinkState()`。场景完成 SDK 登录后创建 CallRtm，SDK 消息和连接变化由场景直接分发给它；`AppCallController` 只接收 `rtm: CallRtm` 与 App/RTC 信息。昵称编解码、同时互拨策略、单通媒体名额和 RTC 资源仍由 App 管理。

### 1.2 已有 App：直接安装 Invitation

[invitation/index.ts](../invitation/index.ts) 导出插件 `Invitation`、单次邀请 `CallInvitation`、两套角色枚举及配置/事件类型。已有 SDK Client 的 App 直接使用插件，无需引入 Demo 的 CallRtm 或页面 Session：

```ts
import { Invitation } from './invitation';

const invitations = new Invitation(rtmClient, {
  userId,
  onIncomingInvitationsChanged: items => renderIncoming(items),
  onCallerStateChanged: event => renderCaller(event),
  onCalleeStateChanged: event => renderCallee(event),
});

const outgoing = invitations.createOutgoingInvitation(targetUid, 'app-defined-data');
outgoing.on('stateChanged', event => renderInvitation(event));
await outgoing.start();
```

`rtmClient` 是 App 已创建并登录的 SDK Client；`userId` 必须与其登录 UID 一致。SDK 公开接口未提供 UID getter，由 App 明确传入。示例渲染函数由 App 提供。

插件自动为该 Client 注册自己的 message/linkState listener，默认初始连接为 connected。login 前安装时使用 `initialLinkState: 'disconnected'`，由真实连接事件推进；仅 STREAM 连接状态变化不影响 USER 邀请。插件不执行 login/logout，不负责 Token，也不修改 SDK 对象。

| 构造选项 | 含义 |
| --- | --- |
| `userId` | 当前 Client 使用的 RTM 登录 UID |
| `initialLinkState?` | 安装时连接状态，默认 connected |
| `invitationOptions?` | 邀请重试与截止配置 |
| `onIncomingInvitationsChanged?` | 完整待处理来电实例数组 |
| `onCallerStateChanged?` | Caller 邀请状态事件 |
| `onCalleeStateChanged?` | Callee 邀请状态事件 |

同一 Client 不重复安装插件。App 应先 `dispose()` 再 SDK logout；dispose 只移除该插件自己的 listener，不移除其他功能的监听。SDK logout 会清理监听，重新登录后应重新安装插件。

## 2. 用户动作与接口

### 2.1 Demo 场景业务函数

| 用户动作 | CallRtm 接口 | 信令与邀请结果 |
| --- | --- | --- |
| 创建邀请 | `createOutgoingInvitation(remoteUid, extra?, options?)` | 返回只读 RtmInvitation，初始为 `IDLE(0)`，尚未发布 |
| 发起邀请 | `sendCallInvitation(callId)` | `IDLE(0) → SENT_TO_CALLEE(1)` 并发布 INVITE；publish resolve 后为 `RECEIVED_BY_CALLEE(2)` |
| 接听指定来电 | `acceptCallInvitation(callId, extra?)` | 发布中保持 `INVITATION_RECEIVED(11)`；成功为 `ACCEPT_SENT_TO_CALLER(12)`，有效 ACK 后为 `ACCEPTED(13)` |
| 拒绝指定来电 | `refuseCallInvitation(callId, extra?)` | 先提交 `REFUSED(14)` 再通知；Caller 有效消费为 `REFUSED_BY_CALLEE(4)` |
| 取消指定呼出 | `cancelCallInvitation(callId, extra?)` | 先提交 `CANCELED(5)` 再通知；Callee 有效消费为 `CANCELED_BY_CALLER(15)` |
| 查询邀请 | `getInvitation(callId)` / `getSnapshot()` | 返回只读句柄；集合为 callerInvitations/incomingInvitations |
| 订阅变化 | `subscribe(listener)` / `on(event, listener)` | 提供快照、来电集合、角色状态与操作错误通知 |
| 恢复时重检 | `checkDeadlines()` | 依照原绝对截止判断，不延长窗口 |
| SDK 消息/连接事件 | `handleMessage(event)` / `handleLinkStateChange()` | 场景事件绑定负责分发，App 媒体层不解析信令 |
| 页面释放 | `dispose()` | 停止所属邀请；Session 另行管理 SDK 生命周期 |

`RtmInvitation` 只有只读 callId、`getSnapshot()` 和 `subscribe(listener)`，不能通过句柄调用 start/accept/refuse/cancel。所有 Demo 邀请操作均经上述业务函数执行，读取快照仍可获得原终态。

### 2.2 直接插件接口

客户直接使用 Invitation 时，`createOutgoingInvitation()` 返回可操作的 CallInvitation；在 start 前注册实例监听，通过 `start()`、`accept(extra?)`、`refuse(extra?)`、`cancel(extra?)` 操作本实例，`stop()` 停止未完成邀请。插件和 CallRtm 使用同一套邀请状态与协议。

`RECEIVED_BY_CALLEE(2)` 由 USER INVITE publish resolve 驱动，不证明 Callee 页面已经显示来电或用户已看到提示。协议不额外发送振铃回执。


App 通话由 [AppCallController](../app/call-controller.ts) 协调，音频资源由 [CallAudioSession](../rtc/call-audio.ts) 管理：

| 用户动作 | App 接口 | 行为 |
| --- | --- | --- |
| 发起呼叫 | `startCall(remoteUid)` | 经 CallRtm 创建并发送邀请，Demo 昵称由 App 编码为 extra |
| 接听/拒绝指定来电 | `accept(callId?)` / `refuse(callId?)` | 经 CallRtm 操作指定来电，省略时取列表第一项 |
| 取消呼出 | `cancel()` | 经 CallRtm 取消当前 Caller 邀请 |
| 挂断 | `end()` | 退出 RTC，邀请接受终态不变 |
| 静音/恢复 | `toggleMute()` | 只操作 RTC 麦克风 |
| 重试麦克风 | `retryMicrophone()` | 重试采集与发布，不改邀请状态 |
| 收起结果 | `dismissResult()` | 只清除 App 结果提示 |
| 页面释放 | `dispose()` | 释放 App 媒体；场景统一停止 CallRtm 和页面 Session |

## 3. 信令载荷与 extra

| customType | 方向 | payload | 有效消费 |
| --- | --- | --- | --- |
| `CALL_KIT_INVITE` | Caller → Callee | `{ callId, extra }` | 建立来电，重复 INVITE 保留原截止 |
| `CALL_KIT_ACCEPT` | Callee → Caller | `{ callId, extra, type: 'accepted' }` | `RECEIVED_BY_CALLEE(2) → ACCEPTED_BY_CALLEE(3)`，回复 ACK |
| `CALL_KIT_ACCEPT` | Caller → Callee | `{ callId, extra, type: 'ack' }` | `ACCEPT_SENT_TO_CALLER(12) → ACCEPTED(13)` |
| `CALL_KIT_REFUSE` | Callee → Caller | `{ callId, extra }` | Caller 提交 `REFUSED_BY_CALLEE(4)` |
| `CALL_KIT_CANCEL` | Caller → Callee | `{ callId, extra }` | Callee 从 `INVITATION_RECEIVED(11)` 或 `ACCEPT_SENT_TO_CALLER(12)` 提交 `CANCELED_BY_CALLER(15)` |

发布固定使用 `channelType: 'USER'`、对应 customType 和 `storeInHistory: false`。场景不需要频道订阅、Presence、Storage 或 Lock。

callId 为 16 字节随机值转换的 32 位大写十六进制字符串，同次邀请共用，新邀请生成新值。对端身份取自 SDK publisher，并与实例固定的对端 UID 核对。

Caller 创建外呼实例时生成 callId；Callee 首次收到合法 INVITE 时，按该 callId 创建本端实例。管理器只向实例路由匹配 callId、预期对端 publisher 的邀请协议 USER 消息。Caller 在 `RECEIVED_BY_CALLEE(2)` 处理 accepted/REFUSE，Callee 在 `ACCEPT_SENT_TO_CALLER(12)` 处理 ACK；与当前状态不匹配的消息直接忽略。

extra 是邀请消息体中的 App 透传字符串，缺省空串；同一 INVITE 重试保留相同 callId/extra。接收参数通过实例/只读句柄快照与状态事件的 remoteExtra 暴露，邀请模块不解析业务内容。Demo App 编解码 `JSON.stringify({ nickname })`。

独立业务消息使用 App 自己的 customType 与 SDK listener：

```ts
const onAppMessage = event => {
  if (event.customType === 'APP_ORDER_UPDATE') handleOrderUpdate(event);
};
rtmClient.addEventListener('message', onAppMessage);
await rtmClient.publish(targetUid, JSON.stringify(orderUpdate), {
  channelType: 'USER',
  customType: 'APP_ORDER_UPDATE',
  storeInHistory: false,
});
```

插件不独占 message 事件，App listener 仍收到自己的业务消息。独立数据不混入四种 CALL_KIT 信令；App 卸载自己的 listener 时按函数引用单独移除。

## 4. 实例、集合与通知

Caller 的稳定终态为 `ACCEPTED_BY_CALLEE(3)`、`REFUSED_BY_CALLEE(4)`、`CANCELED(5)`、`FAILURE(6)`；Callee 的稳定终态为 `ACCEPTED(13)`、`REFUSED(14)`、`CANCELED_BY_CALLER(15)`、`FAILURE(16)`。终态不返回 `IDLE(0)` 或 `IDLE(10)`，下一邀请创建新对象。

getSnapshot 的 callerInvitations 保存 Caller 邀请，incomingInvitations 返回完整待处理来电，按首次接收时间从新到旧排列。插件返回 CallInvitation，CallRtm 返回 RtmInvitation 只读句柄。重复 INVITE 不改变排序或截止，`ACCEPT_SENT_TO_CALLER(12)` 仍保留该项，终态仅移除对应来电。已终结邀请仍可通过 getInvitation(callId) 查询。

| 通知 | 内容 |
| --- | --- |
| `onIncomingInvitationsChanged` / `incomingInvitationsChanged` | 插件完整待处理来电集合；CallRtm 事件提供对应只读句柄数组 |
| `onCallerStateChanged` / `callerStateChanged` | 插件回调或 CallRtm 事件中的 Caller 状态 |
| `onCalleeStateChanged` / `calleeStateChanged` | 插件回调或 CallRtm 事件中的 Callee 状态 |
| `incomingInvitation` | 插件返回 CallInvitation，CallRtm 返回 RtmInvitation |
| 插件实例 `on('stateChanged', listener)` | 单次邀请状态变化；Demo 通过 CallRtm 角色状态事件接收 |
| `operationError` | 接听或通知发送错误 |
| `subscribe(listener)` | 无参数快照变更通知 |

状态事件含 callId、role、localUid、remoteUid、previousState、state、ended、sequence、timestamp 和快照字段；失败时另含 reason、trigger、sdkError、linkStateAtFailure。一次提交只通知一次，sequence 单调递增，监听异常不阻断其他监听。晚注册读取快照，退订不取消邀请。

## 5. 重试、截止与错误

| 配置 | 默认值 | 起点与含义 |
| --- | --- | --- |
| `maxRetries` | 2 | 首次失败后最多再试两次，0 表示不重试 |
| `retryIntervalMs` | 2000ms | INVITE 失败后的间隔 |
| `sendTimeoutMs` | 30000ms | 首次发送起计算，包含全部发布等待与间隔 |
| `callerInvitationExpireMs` | 30000ms | 首次 INVITE publish resolve 后的 Caller 等待 |
| `calleeInvitationExpireMs` | 30000ms | 首次消费 INVITE 后的 Callee 处理与 ACK 等待 |

CallRtm 和插件均可配置 invitationOptions，创建呼出时可为该实例覆盖。重试次数为非负整数，其余配置为正整数毫秒数。任一次 INVITE 成功即停止重发；次数耗尽立即失败，发送总截止独立生效。start 时本端未连接则不发布 INVITE。

accepted 与 ACK 不定时重发。接听发布失败且仍有效时保持 `INVITATION_RECEIVED(11)`、解除占用并报告操作错误，可在原窗口再次操作。进入 `ACCEPT_SENT_TO_CALLER(12)` 后不再本地接听或拒绝，仍可消费 CANCEL。

每阶段固定 startTs/endTs，剩余时间按 `Math.max(0, endTs - Date.now())` 计算。INVITE 重试不延长发送截止，重复 INVITE、再次接听及进入 `ACCEPT_SENT_TO_CALLER(12)` 不延长 Callee 截止。操作、消息、发布结果和重试前重检；App 在恢复可见、pageshow、focus 或 RTM 恢复时补充调用 checkDeadlines。冻结期间无法执行 JavaScript，恢复首个检查按原截止收敛。

| 证据/阶段 | reason | 结果 |
| --- | --- | --- |
| SDK 明确离线，如 `-11033` | PEER_OFFLINE | Caller `FAILURE(6)` |
| 发布错误时本端断连/重连 | LOCAL_NETWORK_ERROR | Caller `FAILURE(6)`，保留失败时证据 |
| connected 且 SDK `-11026` 发布超时 | PUBLISH_TIMEOUT | Caller `FAILURE(6)`，不推断对端离线 |
| connected 且其他发布错误 | PUBLISH_FAILED | Caller `FAILURE(6)` |
| 总发送截止且当前调用 pending | SEND_TIMEOUT | Caller `FAILURE(6)`，不伪造 SDK 错误 |
| Caller 正常连接但等待到期 | PEER_NO_RESPONSE | `RECEIVED_BY_CALLEE(2) → FAILURE(6)` |
| Callee 接听前/发布中到期 | INVITATION_EXPIRE | `INVITATION_RECEIVED(11) → FAILURE(16)` |
| Callee 等 ACK 到原截止 | ACCEPT_ACK_TIMEOUT | `ACCEPT_SENT_TO_CALLER(12) → FAILURE(16)` |
| USER 连接彻底 failed | LOCAL_NETWORK_ERROR | 未终结邀请进入 `FAILURE(6)` 或 `FAILURE(16)` |

reason 解释业务原因，trigger 区分 RETRY_EXHAUSTED、SEND_TIMEOUT、INVITATION_TIMEOUT、ACK_TIMEOUT、LINK_FAILED 或 STOPPED 等终结条件。sdkError 和 linkStateAtFailure 保存原始错误与失败时连接证据，不能用恢复后的 CONNECTED 覆写，也不能凭 CONNECTED 加普通发布失败证明对端离线。

REFUSE/CANCEL/ACK 操作错误不回滚已提交的 `REFUSED(14)`、`CANCELED(5)`、`ACCEPTED_BY_CALLEE(3)`。ACK 丢失时可能 Caller 保留 `ACCEPTED_BY_CALLEE(3)`、Callee 到期为 `FAILURE(16)`；ACK 不提供跨页面的全局原子提交。

## 6. App 媒体与页面生命周期

App 观察 `ACCEPTED_BY_CALLEE(3)` 或 `ACCEPTED(13)` 后建立独立音频。Demo 由 callId 派生 RTC 频道，启动媒体起默认最多等待 15 秒、包含 join；本地已连接且目标加入后展示音频通话。

挂断、RTC 失败、媒体超时或目标离开只结束 App 媒体，邀请接受终态不变。App 空闲不代表原邀请回到 `IDLE(0)` 或 `IDLE(10)`。采集/发布失败单独提示并允许重试，不改邀请结果。对端尚未加入时，本端挂断后对端可能依靠媒体截止收敛。

邀请支持多来电；Demo App 一次预留一通音频，其余项继续计时，可逐条拒绝，名额释放后可接听仍有效的项。媒体资源独立，旧清理不影响新通话。

页面 Session 拥有唯一 SDK Client，在 login 前注册事件。同页失败重试复用 Client；导航整页加载，pagehide 或真正卸载时释放 App 媒体、停止 CallRtm，再由 Session 尽力 logout。Strict Mode 模拟卸载不注销。刷新可保留 Tab 呼叫 ID，不恢复旧邀请或媒体。

## 7. 源码与数据流

| 文件 | 职责 |
| --- | --- |
| [rtm.ts](../rtm.ts) | Demo 业务函数、只读邀请句柄和插件适配 |
| [invitation/index.ts](../invitation/index.ts) | 可复制目录的公共入口与类型导出 |
| [invitation/call-controller.ts](../invitation/call-controller.ts) | Invitation 管理、SDK 绑定、集合和路由 |
| [invitation/call-invitation.ts](../invitation/call-invitation.ts) | 每通邀请、计时、重试、状态和通知 |
| [invitation/call-state.ts](../invitation/call-state.ts) / [invitation/call-protocol.ts](../invitation/call-protocol.ts) | 两套枚举、配置和信令 |
| [invitation/call-errors.ts](../invitation/call-errors.ts) | SDK 原始错误提取 |
| [app-rtm.ts](../app-rtm.ts) | 页面 SDK Client、登录、已登录端口与 RTM trace |
| [app/call-controller.ts](../app/call-controller.ts) | App 通话策略、页面状态类型与 RTC 生命周期衔接 |
| [app/identity.ts](../app/identity.ts) | Demo UID 生成、输入校验与昵称规则 |
| [rtc/call-audio.ts](../rtc/call-audio.ts) | RTC 音频连接、麦克风、错误提取与资源释放 |
| [test/scene.test-helpers.ts](../test/scene.test-helpers.ts) | 外壳与场景组件测试共用的无网络 RTM/RTC 替身 |

CallRtm 通过页面 Session 的已登录端口发布信令，保留真实 API trace。App 所需信令类型与角色枚举统一从 rtm.ts 引用。

数据流仅展示 RTM API/Event，按 callId 关联，ACCEPT 摘要区分 type=accepted/type=ack，不展示 extra 正文。SDK message 先记录 EVENT，再补业务消费结果；RTC 不进入 RTM 数据流。

UID 路由、callId 匹配和去重属于客户端协作。生产应用仍须由 App Server 认证用户、签发 Token、限制路由并按业务需要提供推送、多设备与持久化。本项目不接收 App Certificate，不在浏览器生成 Token。
