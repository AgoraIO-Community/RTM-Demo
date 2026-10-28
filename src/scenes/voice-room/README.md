# 语聊房中的 RTM 使用

这个目录实现了一个可真实联调的单页语聊房，用来展示 Agora RTM Web SDK 在语聊房场景中的典型用法：房间状态怎样同步，成员临时状态怎样传播，以及排麦、邀请、聊天和治理动作怎样发送给一个人或整个房间。

每个浏览器 Tab 只运行一个角色和一个 RTM client。真实联调时，Host 与 Audience 分别打开两个 Tab，使用不同的 RTM UID，输入相同房间名称加入同一个房间。

项目安装、App ID 配置、局域网 HTTPS 与公共安全边界见[根 README](../../../README.md)。本文件只说明语聊房的体验和接入。

## 双页面体验

1. 在一个页面选择“语聊房”，通过“创建”卡片填写房间名称和选填昵称，以 Host 身份创建房间。
2. 在另一个页面或设备使用同一 App ID，在“加入”卡片输入相同名称，以 Audience 身份加入。
3. 观察成员在线与昵称，申请、审批或邀请上麦；继续体验公屏消息、公告、自主静音和强制麦控，并对照右侧 RTM 数据流。
4. Host 可暂时离开；房间仍为 active，成员继续互动，入口提供“以 Host 身份返回”恢复本轮身份。主动解散才结束房间，名称可重新创建，新一轮使用不同 roomId。

页面不提供邀请链接输入或复制入口；旧版完整房间 URL 仍用于已有链接兼容和刷新恢复，不作为新的入房主流程。昵称最多 20 个 Unicode 码点，允许重名，不参与权限判断。真实音频联调必须戴耳机。

左侧五项任务依次关注连接入房、成员在线、上麦协同、房内消息和房间状态同步；只有成功调用或消费到的真实状态能推进任务，默认麦位和本地消息回显不算远端证据。

## 建议先读

| 材料 | 内容 |
| --- | --- |
| [《语聊房模块与依赖关系》](./docs/语聊房模块与依赖关系.md) | 页面、准入、业务状态、角色 RTM、事件处理与 RTC 的依赖图，以及已登录 Client 实例的归属 |
| [`app-rtm.ts`](./app-rtm.ts) | 单页应用怎样创建唯一 RTM client、在登录前注册事件、登录、复用和退出 |
| [`host/rtm.ts`](./host/rtm.ts) | Host 的房间初始化、麦位、邀请、治理和公屏动作怎样使用 RTM |
| [`audience/rtm.ts`](./audience/rtm.ts) | Audience 的申请上麦、接受邀请、下麦和公屏动作怎样使用 RTM |
| [《语聊房功能、底层 RTM API、事件与时序》](./docs/语聊房功能底层-RTM-API-事件与时序.md) | 各项功能的发送、接收、状态消费和关键时序 |
| [《语聊房功能与 RTM 函数映射》](./docs/语聊房功能与-rtm-函数映射.md) | 从场景功能直接跳转到对应 Host/Audience 源码实现 |
| [《语聊房端到端回归流程》](./docs/语聊房端到端回归流程.md) | 双页面人工流程、预期数据流与 Playwright 用例的一一对应矩阵 |
| [《按名称加入与共享目录》](./docs/按名称加入与共享目录.md) | 名称登记、准入、刷新恢复、解散清理，以及必须替换的 Demo-only 目录 |

## 接入边界与源码导航

角色 RTM 是接入样板，RTC 是让场景能够真实播放音频的配套。Host/Audience 的 `rtm.ts` 与 `onRtmEvent.ts` 刻意独立，不抽跨角色基类；它们依赖页面级会话和业务消费，**单独复制一个 `rtm.ts` 不构成完整接入**。共享 RTC 辅助不意味着其他场景必须采用相同媒体架构。

| 文件 | 职责 |
| --- | --- |
| [VoiceRoomScene.tsx](./VoiceRoomScene.tsx) | 场景装配、入口与页面展示 |
| [app-rtm.ts](./app-rtm.ts) | 页面唯一 SDK Client、登录、连接事件与调用适配 |
| [room-entry-controller.ts](./room-entry-controller.ts) | 创建、准入、刷新恢复与 generation 防护 |
| [event-driven-single-room-client.ts](./event-driven-single-room-client.ts) | 当前单角色的业务状态、事件消费与 RTC 协调 |
| [Host RTM](./host/rtm.ts) / [Audience RTM](./audience/rtm.ts) | 按用户功能命名的角色操作与 trace |
| [Host 事件](./host/onRtmEvent.ts) / [Audience 事件](./audience/onRtmEvent.ts) | 入站过滤、信封校验、去重及业务消费 |
| [name-directory.ts](./name-directory.ts) | 仅 Demo 使用的房间名称目录，生产时交给 App Server |
| [voice-room-url.ts](./voice-room-url.ts) | 名称、房间与本端身份的 URL 编解码及已有链接兼容 |

每个入房成员加入 RTC 以收听音频，只有实际在麦位上的成员才采集并发布麦克风。数据流只呈现 RTM，不采集 RTC；实现与维护约束集中在[模块文档第 7 节](./docs/语聊房模块与依赖关系.md#7-关键实现约束)。

## 先理解几个术语

| 术语 | 在本文中的意思 |
| --- | --- |
| RTM | Real-Time Messaging，实时信令与状态同步。本场景用它同步房间状态和用户动作，不传输音频 |
| RTC | Real-Time Communication，实时音视频。本场景的声音由 RTC 传输，RTM 只负责协调谁在麦位上以及相关状态 |
| RTM client | Agora RTM SDK 创建的客户端对象。一个 client 使用一个 RTM UID 登录，负责订阅房间、收发消息和读写 RTM 状态 |
| RTM UID | 用户登录 RTM 时使用的唯一标识。它是 RTM 消息的发送者和接收者标识，不等于业务数据库里的用户主键 |
| 房间 / Channel | 多个 RTM 用户共同订阅的逻辑频道。本 Demo 直接使用 `roomId` 作为 Channel Name；订阅后才能收到该房间的消息和状态事件 |
| Channel Type | SDK 用来区分消息发往房间还是单个用户的类型。本 Demo 使用 `MESSAGE` 表示房间频道，使用 `USER` 表示点对点用户频道 |
| listener / event | listener 是提前注册的事件处理函数；event 是 SDK 在连接变化、收到消息或状态变化时传给该函数的数据 |
| publisher | SDK 事件中的消息或状态发布者，值是发送方的 RTM UID |
| Channel Storage | RTM 提供的频道键值存储，也称 Channel Metadata。它适合保存订阅者需要获得的当前房间状态，不是业务数据库 |
| Presence State | 某个在线 RTM 用户附带的临时键值状态。成员离线后不应把它当作持久用户资料 |
| `USER` Message | 点对点消息。发布时 Channel Name 填目标 RTM UID，只有目标用户接收 |
| `MESSAGE` Message | 房间消息。发布时 Channel Name 填 `roomId`，订阅该房间的用户接收 |
| token | 服务端签发给用户的短期访问凭证，用来证明该用户有权登录 RTM 或加入 RTC；不应在浏览器中生成 |
| App Server | 业务自己的服务端，负责账号、数据库、房间目录、权限、token 和其他不能信任客户端自行决定的逻辑 |

## RTM 在这个语聊房中承担什么

| RTM 能力 | 本场景中的用途 | 示例 |
| --- | --- | --- |
| Channel Storage | 保存加入房间后需要获得的完整房间状态 | Host UID、公告、完整麦位表、强制静音名单 |
| Presence State | 同步在线成员的临时状态 | 自主静音、麦克风异常 |
| `USER` Message | 向一个指定用户发送瞬时动作 | 排麦申请、拒绝、上麦邀请、主动下麦、踢出和封禁通知 |
| `MESSAGE` Message | 向整个房间广播瞬时动作 | 聊天、礼物、爱心和房间解散通知 |

选择原则是：需要新成员拿到当前完整结果的状态放在 Storage；只属于在线成员且会随离线消失的临时状态放在 Presence；一次性的业务动作使用 Message。只发给一个人的动作使用 `USER`，房间内所有人都需要收到的动作使用 `MESSAGE`。

## `app-rtm.ts` 做什么

`AppRtmSession` 与单页应用的生命周期一致，是页面内唯一的 RTM SDK client 所有者：

- 创建一个 RTM client；
- 在 `login()` 前注册 `linkState`、`message`、`presence`、`storage` 和 `token` listener；
- 完成登录，并向当前 Host 或 Audience 提供同一个房间操作端口；
- 名称目录只在入房前通过 Metadata API 读写，不订阅，也不进入数据流；
- 角色离房时继续保留已登录 client，只取消房间订阅；
- 页面离开或真正卸载时，清理房间与 RTC，移除 listener 并尽力调用 `logout()`。

它只处理 SDK client 和页面生命周期，不理解排麦、麦位、公告、nickname 或 RTC。

## Host/Audience `rtm.ts` 做什么

两端 `rtm.ts` 把用户功能固定映射到 RTM 调用。业务代码调用的是 `requestSeat()`、`approveSeatRequest()`、`muteMicrophone()` 等语义函数，而不是自行传入任意消息 type 或 metadata key。

Host 负责：

- 订阅和退订房间；
- 初始化和更新 Channel Storage；
- 审批排麦、邀请上麦；
- 更新公告、麦位和强制静音名单；
- 发送踢出、封禁、解散和公屏消息。

Audience 负责：

- 订阅和退订房间；
- 申请上麦、接受或拒绝邀请、主动下麦；
- 更新自己的 Presence 临时状态；
- 发送公屏消息。

Host 与 Audience 的能力不同，因此分别保留两份 `rtm.ts`。Audience 不写 Channel Storage，最终麦位归属始终由 Host 写入。

通用的 `publishToUser()`、`publishToRoom()`、`setPresenceState()` 和 `setRoomMetadata()` 保持私有，避免业务代码绕过场景协议。

## 事件怎样回到业务

[`host/onRtmEvent.ts`](./host/onRtmEvent.ts) 和 [`audience/onRtmEvent.ts`](./audience/onRtmEvent.ts) 接收页面级 client 转发的 SDK 事件，并负责：

- 过滤房间和 Channel Type；
- 校验消息信封的版本、房间、目标用户和有效期，具体含义见下一节；
- 使用 `messageId` 去重；
- 把合法事件交给 [`event-driven-single-room-client.ts`](./event-driven-single-room-client.ts) 更新语聊房状态。

## 消息信封、校验、TTL 和去重

RTM SDK 只负责传递字符串，并不知道“申请上麦”或“踢出成员”是什么。本 Demo 会先把业务内容包装成一个 JSON 对象再发送，这个外层对象称为**消息信封**。

例如，Audience 向 Host 申请 2 号麦位时，实际发送的字符串解析后类似：

```json
{
  "schemaVersion": 1,
  "messageId": "8f3a...",
  "type": "seat.request",
  "roomId": "room-1001",
  "targetUserId": "host-1001",
  "sentAt": 1787191200000,
  "expiresAt": 1787191215000,
  "payload": {
    "requestId": "req-1001",
    "seatId": "seat-1"
  }
}
```

- `schemaVersion`：信封格式版本。接收方只处理自己认识的版本。
- `messageId`：每条消息的唯一 ID，用于识别重复消息。
- `type`：业务动作类型，例如 `seat.request` 或 `room.dissolved`。
- `roomId`：消息所属房间，防止其他房间的消息进入当前状态。
- `targetUserId`：点对点消息的目标 RTM UID；房间广播不需要该字段。
- `sentAt`：发送时间，使用 Unix 毫秒时间戳。
- `expiresAt`：过期时间，同样使用 Unix 毫秒时间戳。
- `payload`：真正的业务参数。上例中是申请 ID 和目标麦位。

**信封校验**是指接收方在执行业务动作前依次检查：消息能否解析为 JSON、必填字段和类型是否正确、`schemaVersion` 是否支持、`roomId` 是否是当前房间，以及点对点消息的 `targetUserId` 是否是本端 UID。不满足条件的消息直接丢弃，不进入语聊房状态。

**TTL** 是 *Time To Live*，即消息允许存活的时间。本 Demo 发出的消息 TTL 固定为 15 秒：`expiresAt = sentAt + 15 秒`。接收时如果当前时间已经达到或超过 `expiresAt`，说明这个瞬时动作已经过时，例如用户不应在很久以后才收到一条旧的上麦邀请，因此直接丢弃。TTL 只决定“过期后不处理”，不保证消息一定送达。

**去重**是指本端记住最近已经接受的 `messageId`；再次收到相同 ID 时不重复执行业务动作。本 Demo 最多保留最近 500 个 ID，防止去重集合无限增长。

普通房内消息不自动重试。目录竞争写入通过重新读取确认结果，治理 P2P 失败可以在目标重新加入后补发；这些机制不等于重放普通房内消息。`publish()` 成功只表示 SDK 的发布调用成功完成，不表示目标客户端已经执行了对应业务动作。

更完整的排麦、邀请、下麦、麦克风异常和房间解散链路见[时序文档](./docs/语聊房功能底层-RTM-API-事件与时序.md)。

## Demo 中由浏览器代替 App Server 的部分

这个仓库没有 App Server。为了让 Demo clone 后可以直接运行，以下能力临时放在浏览器中实现；接入真实业务时应替换，而不是照搬。

### 房间目录、成员准入和封禁

新房间使用 RTM Channel Metadata 临时模拟共享名称、房间状态和封禁名单；每个名称一个目录频道，实际房间仍只保存原有四个 key。Host 创建或刷新、Audience 加入时都在实际房间 subscribe 前读取目录；双方都不订阅目录。URL 携带 nameKey、本轮 roomId 与页面身份。详见[按名称加入与共享目录](./docs/按名称加入与共享目录.md)。

**生产环境严禁参考该 Metadata 目录实现。** 客户必须由 App Server 提供房间创建与查询、成员准入、封禁、房间生命周期、并发控制和邀请校验。邀请链接通常只携带房间 ID 或服务端签发的邀请凭证，不应把 RTM Metadata 当成可强制鉴权的服务端目录。

### 用户身份和 nickname

Demo 没有用户数据库，因此把 `displayName` 临时写入 Presence State，让其他客户端能显示 nickname。这只是为了完成演示，不是推荐的用户资料存储方式。

创建和按名称加入时均可填写“你的昵称”，也可留空：房主默认 `Host`，观众继续按页面 UID 生成稳定的英文昵称。昵称支持中文和 Emoji，执行 NFC 规范化与首尾去空格，最多 20 个 Unicode 码点（组合 Emoji 可能占多个码点），拒绝换行、控制字符和只有不可见字符的输入。房间名称仍使用独立的名称规则。

昵称允许重复，入房后固定；邀请、麦位、消息身份和封禁仍按 UID 定位。页面 UID 由前端自动生成，有效 V2 房间 URL 中的 `pageUid` 和 `nickname` 用于刷新恢复；Audience 首次直达链接的 `pageUid` 为 null，加入成功后生成并写回当前页面 UID。昵称为 null 时沿用角色默认值。

暂离或失败后返回入口保留本页输入；再次提交可选新昵称，当前页面 UID 不变。不增加跨页面昵称偏好、账号资料存储或房内改名。本端在初始化 Presence 写入成功后更新自己的昵称映射，不依赖自身状态事件回推；远端昵称仍来自 Presence 事件，缺少该成员状态时沿用省略 UID 的降级显示。写入失败或离房后迟到的成功结果不更新本端映射。

生产环境应由 App Server 维护身份关系。`App UID` 是业务系统中唯一标识一名用户的主键，同一条用户记录关联该用户的 nickname、avatar 和 RTM UID，例如：

```text
App UID（唯一主键）
├── nickname
├── avatar
└── RTM UID（唯一，用于登录 RTM 和反查 App 用户）
```

客户端登录业务账号后，App Server 根据 App UID 返回当前用户的 nickname、avatar、RTM UID 和相关 token。收到 RTM 事件时，客户端可以使用事件中的 publisher RTM UID，通过 App Server 接口或业务侧成员资料缓存反查 App UID，再取得 nickname 和 avatar。若 App UID 与 RTM UID 是一对一关系，数据库还应为 RTM UID 建立唯一索引，保证反向查询不会对应到多个 App 用户。

Presence 更适合承载 `muted`、`microphoneError` 这类在线临时状态，不应替代业务用户数据库。

### Token 与权限

Token 服务需由客户自行实现，参考[声网 Token 工具与说明](https://console.shengwang.cn/tools/token)。

踢出、封禁和强制麦控在本 Demo 中都是客户端协作行为，不构成服务端权限控制。

根目录 [`README.md`](../../../README.md) 提供运行、环境注入和整个场景实验室的说明。
