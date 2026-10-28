# RTM 场景实验室 · Spec

更新日期：2026-10-23

本文维护实验室公共外壳与语聊房的当前产品和运行契约，不是待执行的历史任务清单。场景使用入口见[语聊房 README](../../../src/scenes/voice-room/README.md)与[1V1 呼叫邀请 README](../../../src/scenes/one-to-one-call/README.md)；1V1 的邀请协议与媒体策略以其场景正式文档为准。

## 产品目标

RTM 场景实验室让开发者在可操作的业务场景中观察 RTM API、服务端事件、调用顺序和耗时。数据流面板是核心展示物，只呈现值得客户学习和复用的实际房间 RTM 组合方法。

顶部提供七个一级场景：语聊房、1V1 呼叫邀请、电商直播、在线课堂、虚拟世界、游戏互动、文档协同。语聊房与 1V1 已实现，其余场景进入统一占位页。

## 应用结构

- 根目录只有一个应用入口、一份构建配置和一套 E2E。
- `app/` 负责路由、导航、配置、身份、主题和全站样式。
- `scenes/` 负责语聊房、1V1 呼叫邀请等业务场景。
- `shared/` 负责体验路径、数据流和 RTC 辅助。
- 每个语聊房标签页只运行一个角色和一个页面级 RTM client。
- Host 与 Audience 的真实联调使用两个标签页。
- 页面级 RTM client 由当前场景持有，在 login 前注册事件；离开房间只 unsubscribe，pagehide／真正卸载才尽力 logout。场景导航使用整页跳转，不缓存跨场景 Session。同页登录重试复用原 Client，Strict Mode 模拟卸载不注销；历史缓存恢复时重新加载。主题保留，体验进度、数据流、侧栏状态重置。

语聊房运行路径为：

```text
VoiceRoomScene
→ RoomEntryController
→ event-driven-single-room-client
→ Host/Audience rtm + onRtmEvent
→ AppRtmSession
→ agora-rtm
```

Host 与 Audience 各自保留 `rtm.ts` 和 `onRtmEvent.ts`，不抽取跨角色 RTM 基类。`rtm.ts` 暴露按业务功能命名的操作；`onRtmEvent.ts` 负责事件过滤、协议校验、TTL、目标校验和去重；业务状态集中在单角色业务 store。

## 配置与身份

应用只接收 App ID，不接收 App Certificate，不生成 token，也不预置项目凭证。App ID 的读取顺序为页面全局注入、Vite 环境变量、未配置状态。

鉴权配置在启动时读取，只通过 `VITE_AUTH_MODE=token|none` 选择模式，开发默认 `none`、生产默认 `token`。所有场景复用 `src/shared/utils/token.ts`，Token 请求路径固定为代码中的 `/api/token`，不提供运行时鉴权覆盖或端点环境变量。`token` 模式在 RTM 登录和 RTC 入会前获取并传入对应 Token；`none` 模式工具返回 `undefined`，RTM 不传 Token，RTC 按 SDK 类型契约转换为 `null`。不新增续期或专门的失败提示，不改角色 RTM 或邀请插件。客户需自行实现 Token 服务并参考 https://console.shengwang.cn/tools/token；对外 README 仅简述模式与客户接入责任，不展开 Demo 签发服务或部署细节。

语聊房 URL 使用一个 `data` Base64URL 参数，携带名称 key、房间 ID、角色、页面 UID 和 nickname。每个标签页创建稳定的页面 UID；Host 刷新时使用相同页面 UID 恢复身份。此约定不泛化到其他场景。

nickname 最多 20 个 Unicode 码点，允许重名。空 nickname 使用角色默认值。nickname 只通过 Presence State 在实际房间中同步，不参与名称匹配或权限判断。

## 名称目录

Demo 使用独立的 RTM Channel Metadata 保存房间名称目录。生产环境必须由客户 App Server 实现房间发现、准入、封禁、生命周期、鉴权和并发控制。

每个规范化房间名称映射到一个 Metadata-only 目录频道，`entry` 包含：

- 规范名称与展示名称；
- 当前 `roomId`；
- `hostUserId`；
- `active` 或 `inactive` 状态；
- 创建和结束时间；
- `banUserIds`。

目录只用于创建竞争、Host 刷新恢复和 Audience 入房前查询。Host 与 Audience 都不订阅目录频道。目录产生的所有 RTM API 和事件都不进入数据流面板。

### Host 创建与恢复

Host 创建或刷新时先调用目录 `getChannelMetadata()`：

- 记录属于当前 Host：使用记录中的 `roomId` 恢复；
- 记录属于其他 Host：提示“房间被占用，请更换房间名再次创建”；
- 没有记录：生成随机 `roomId`，使用读取到的 `majorRevision` 竞争写入目录。

竞争写入失败后每隔 300ms 重试，最多再重试两次。每次失败后重新读取目录：

- 目录已是当前 Host 与本次 `roomId`：确认前一次写入实际成功；
- 目录已属于其他 Host：立即按名称被占用处理；
- 共三次仍不能确认成功：统一提示名称被占用。

目录登记成功而实际房间 subscribe 失败时，删除本次登记，避免留下无法加入的房间。刷新、关闭标签页、浏览器崩溃和网络断开都不修改目录；只有 Host 主动解散才结束该记录。

### Audience 准入

Audience 入房前调用一次目录 `getChannelMetadata()`，确认房间存在、状态为 active 且自身 UID 未被封禁，然后使用目录中的 `roomId` 加入。入房后不再读取或订阅目录。

## 实际房间入房

Host 与 Audience 都在 subscribe 实际房间前调用 `presence.setState()` 写入 nickname；Host 同时写入 `muted=false`。

```text
目录查询或登记
→ presence.setState(displayName[, muted=false])
→ subscribe(roomId)
→ subscribe 成功立即撤掉初始蒙层并启动 RTC
```

`subscribe()` 的 Promise 只表示 SDK 订阅完成，不等待 Presence 或 Storage 首快照。权威房间状态尚未到达时，依赖该状态的操作保持禁用。

实际房间只订阅 Message、Presence 和 Metadata，`withLock=false`。

## 实际房间状态

实际房间 Channel Metadata 只有四个 key：

- `hostUserId`；
- `announcement`；
- `seats`；
- `forcedMutedUserIds`。

Host 收到空的首次 Storage SNAPSHOT 时，使用该快照的 `majorRevision` 一次初始化四项数据。其他完整 Storage 事件直接替换本地权威状态。Audience 不写实际房间 Storage，也不主动读取实际房间 Metadata。

`announcement` 独立写入。涉及 `seats` 的读改写共用一条串行队列，涉及 `forcedMutedUserIds` 的读改写使用另一条串行队列。

麦位只表达归属，不表达媒体发布结果。RTC 发布失败不回滚麦位，用户可以保留麦位并重试。自主静音和麦克风设备异常使用 Presence State；强制静音使用 `forcedMutedUserIds`。

## Presence

Presence 是 nickname、在线成员、自主静音和麦克风异常的来源。

- SNAPSHOT 全量替换在线 UID 和成员 State；
- REMOTE_JOIN、REMOTE_LEAVE、REMOTE_TIMEOUT、REMOTE_STATE_CHANGED 和 REMOTE_STATE_CHANGED_INTERVAL 做增量更新；
- Host 缺少 nickname 或离线时展示 `Host`，其他成员缺少 nickname 或离线时展示省略后的 UID；
- Storage 中的 `seat.displayName` 不作为 nickname 来源；
- Audience 下麦时删除 `muted` 和 `microphoneError`；
- Host 保留 `muted=false` 作为初始 Presence State。

## 断线重连

SDK 自动重连期间不重复 subscribe、不读取目录、不重放历史消息。

Audience 检测到实际房间连接中断后显示交互蒙层。`linkState=CONNECTED` 只表示链路恢复，不能撤掉蒙层。收到重连后的实际房间 Storage 事件后：

- Metadata 非空且四项数据有效：更新权威状态并撤掉蒙层；
- Metadata 为空：按房间已解散处理，执行 RTC leave、RTM unsubscribe 和本地状态清理。

初次订阅不等待 Storage；只有发生过断线的 Audience 才执行上述恢复门槛。

## 消息协议

房内消息使用统一信封，包含协议版本、消息 ID、房间 ID、可选目标 UID、发送时间、过期时间和 payload。接收端先校验频道、来源、目标、TTL 和消息 ID，再消费业务消息。

普通房内消息不自动重试。排麦申请只能使用 USER P2P；聊天、礼物、爱心和解散通知使用实际房间 MESSAGE。

## 封禁与踢出

封禁同时尝试以下操作，任一失败不阻止其他操作：

- 把目标 UID 写入目录 `banUserIds`；
- 清除目标麦位；
- 发送 USER `member.ban`。

踢出同时尝试清除目标麦位和发送 USER `member.kick`。Audience 收到 `member.ban` 或 `member.kick` 后立即退出。

P2P 发送失败时，Host 按目标 UID 保存待处理动作。收到该 UID 的 `REMOTE_JOIN` 后重新发送；成功后删除待处理动作，失败则继续保留。

目录、封禁和踢出属于生产环境的服务端能力。Demo 中相关目录操作、P2P API 和 P2P 事件都不进入数据流面板，但失败必须显示明确 toast。

## 解散

Host 解散房间的顺序为：

```text
目录置为 inactive
→ 发布 room.dissolved
→ 清理实际房间四项 Metadata
→ Host unsubscribe 实际房间
→ 删除目录 entry
```

`room.dissolved` 发布失败必须 toast，但不阻止后续清理。实际房间 Metadata 清理失败后每隔 300ms 重试，最多共三次；实际房间或目录仍未清理时在入口保留再次清理操作，重试只补做未完成部分。删除目录前必须重新读取并核对 hostUserId 与 roomId，删除操作携带 majorRevision，迟到清理不得删除同名新房间记录。

Audience 收到 `room.dissolved` 或空的实际房间 Metadata 时执行相同的退出语义。

## 错误处理

除名称目录和治理模拟操作外，所有失败的 RTM API 都产生一次 toast，并在数据流中展示错误码和错误信息。目录使用入口、占用或清理场景自己的错误提示。治理模拟操作不进入数据流，但失败仍产生 toast。

异步事件消费失败也通过业务 store 显示 toast。错误提示不得覆盖已成功完成的其他并行操作。

## 数据流

语聊房数据流只展示：

- 页面级 `rtm.login` 和 `linkState`；
- 实际房间 RTM API；
- 实际房间 RTM 事件。

目录 API/Event、封禁与踢出治理模拟、RTC 操作都不展示。

数据流按时间从新到旧排列。条目最小 70px 高，API 使用薄荷绿标识，EVENT 使用天蓝标识；第二行业务摘要完整展示并自动换行，只有房间名和 UID 按约定缩写，首行 API 名过长时省略。新条目只让边框和光晕呼吸。用户可以筛选 API/Event、隐藏连接事件、折叠面板和清空数据流。具体格式见[共享展示规范](../../../src/shared/timeline/数据流看板-API-与-Event-展示规范.md)。

页面生命周期内 trace 只追加。角色切换、离房、解散、踢出或封禁都不删除已经产生的可见 trace。

## 体验路径

语聊房体验任务包括建立房间连接、成员在线、上麦协同、房内消息和同步房间状态。

“建立房间连接”的说明为：

> 填写名称创建房间，或输入房主分享的名称以听众身份加入。右侧可查看登录与房间订阅过程。

“同步房间状态”的完成条件按角色区分：

- Host：完成公告更新和强制静音用户后标绿；
- Audience：收到公告更新或某个用户被静音中的任一项后标绿。

Hover 文案同时说明 Host 的操作路径和 Audience 的观察路径。失败 API、默认 Host 麦位和本地消息回显不能推进体验任务。清空数据流和切换房间不重置本次场景访问的进度。

## 界面与设计

界面使用“墨 · Ink”设计系统。全站颜色由 `styles.css` 的语义 token 提供，支持 light/dark 主题。桌面为体验路径、场景主区、数据流三栏；左右栏支持折叠，窄屏使用覆盖主区的抽屉。

语聊房主区包含麦位、公告、公屏和角色治理面板。只有用户当前选中的麦位显示 selected ring；Host 麦位不因身份自动显示选中态。公屏保留全部历史并滚动，新消息到达时滚到底部。

## 测试与验收

- Vitest 覆盖目录竞争、刷新恢复、Presence 前置写入、订阅时序、Storage 全量状态、重连蒙层、空 Metadata 解散、治理重发、清理重试、错误 toast 和体验进度。
- 角色 RTM 测试断言业务操作映射到正确的 SDK primitive、频道和消息类型。
- 场景测试使用无网络替身，不连接真实 RTM。
- Playwright 无头覆盖桌面和移动端关键流程。
- E2E 使用占位 App ID，不验证真实 Agora 连通性。
- 使用有效项目凭证进行双标签页人工验收时必须戴耳机。

## 生产边界

名称目录、准入、封禁、踢出和强制麦控在 Demo 中都是客户端协作行为，不构成信任边界。生产环境必须由客户 App Server、服务端 SDK 或 RESTful API 完成鉴权和治理。

仓库不包含真实 App ID、App Certificate 或 token 签发逻辑。生产环境必须由客户 App Server 签发 token。
