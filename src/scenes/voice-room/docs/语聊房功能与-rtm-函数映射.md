# 语聊房功能与 RTM 函数映射

更新日期：2026-09-14

本文是语聊房当前的函数级契约。用户动作必须对应到角色 `rtm.ts` 中的语义函数；SDK 事件由角色 `onRtmEvent.ts` 绑定，并分发给业务 store 中的独立消费函数。

约束：

- UID 是内部目标键；UI 和可读 trace 优先使用 Presence nickname，Presence 中无 nickname 或用户已离线时使用省略后的 UID。
- `app-rtm.ts` 与语聊房页面生命周期对齐：页面挂载时创建唯一 SDK client，在 `login()` 前注册监听器，通过 `bindRtmEvents()` 把事件切换给当前角色；页面离开或真正卸载时清理并尽力 `logout()`。
- `rtm.ts` 内部可保留通用信封、发布、Storage 写入和 API/event trace 辅助函数，但不直接依赖 `RTMEvents`，不解析收到的信封，也不向业务层暴露通用“传 type/key”接口。
- Host/Audience 各自的 `onRtmEvent.ts` 只负责事件过滤、信封校验、TTL、去重、trace 顺序和 listener 调用；它不维护 nickname、麦位或业务状态。
- 每个公开语义函数只完成一个用户动作。
- 事件消费函数不直接调用 SDK；它们可以更新 store、触发 RTC、生成公屏系统消息，或驱动业务 store 调用角色 `rtm.ts` 的语义函数。
- nickname 映射、麦位解析和可读摘要属于业务桥接层；`rtm.ts` 不维护第二份 nickname store，也不解析 Storage 来理解麦位业务。Storage `seat.displayName` 不作为 nickname 来源。
- 业务 store listener 返回 `summary` 和延迟执行的 `consume`；`onRtmEvent.ts` 先记录事件 trace，再调用 `consume`，并统一观察异步失败。

## 房间生命周期

### [`subscribeRoom()`（Host）](../host/rtm.ts#L175) / [`subscribeRoom()`（Audience）](../audience/rtm.ts#L157)

模块：Host/Audience `rtm.ts`。先通过对应 `onRtmEvent.ts` 绑定当前角色 listener，再订阅房间 Message、Presence 和 Metadata；Promise 只等 SDK `subscribe()`。

业务桥接层在客户端构造时先建立非权威初始展示 store。Audience 在 subscribe 前读取一次 Demo-only 名称目录并完成准入校验；Host 也在创建或刷新时读取目录。双方先调用 `initializeMemberState()`，再订阅实际房间，不订阅目录。`subscribeRoom()` 成功即切换到 `room`、撤掉初始蒙层并启动 RTC；首个可解析 Storage 事件建立权威基线，在此之前依赖 Metadata 的操作保持禁用。

### [`unsubscribeRoom()`（Host）](../host/rtm.ts#L207) / [`unsubscribeRoom()`（Audience）](../audience/rtm.ts#L189)

模块：Host/Audience `rtm.ts`。取消当前房间订阅并让对应 `onRtmEvent.ts` 解绑角色事件，不 logout。

应用级 `AppRtmSession` 在调用 `login()` 前注册 SDK listener，并从页面进入开始统一记录真实 `linkState` 事件与 `rtm.login` API trace。Host/Audience `onRtmEvent` 只消费 linkState 更新业务状态，不重复记录。连接事件默认展示，可由用户点击“隐藏连接”。暂时离开、解散、被踢和被封禁产生的 `rtm.unsubscribe` 都必须保留在当前数据流中。

### [`initializeRoom(initialMetadata, majorRevision, summary)`](../host/rtm.ts#L224)

模块：Host `rtm.ts`。只在空 Storage `SNAPSHOT` 上一次写入四个初始 key；业务桥接层同时传入四项完整 Metadata 的可读摘要，API trace 不用 `initialize` 代替实际写入内容。

## 麦克风与 Presence State

### [`initializeMemberState(displayName)`（Host）](../host/rtm.ts#L253) / [`initializeMemberState(displayName)`（Audience）](../audience/rtm.ts#L206)

模块：Host/Audience `rtm.ts`。订阅实际房间前首次写 Presence State。Host 写入 `{ displayName, muted: "false" }`；Audience 尚未上麦，只写 `{ displayName }`。Audience RTC 发布成功后才增量写 `muted`。

### [`muteMicrophone()`（Host）](../host/rtm.ts#L258) / [`muteMicrophone()`（Audience）](../audience/rtm.ts#L211)

模块：Host/Audience `rtm.ts`。本端在麦位时增量调用 `presence.setState({ muted: "true" })`，不重复写 nickname。

### [`unmuteMicrophone()`（Host）](../host/rtm.ts#L263) / [`unmuteMicrophone()`（Audience）](../audience/rtm.ts#L216)

模块：Host/Audience `rtm.ts`。本端在麦位时增量调用 `presence.setState({ muted: "false" })`，不重复写 nickname。

### [`reportMicrophoneError()`（Host）](../host/rtm.ts#L268) / [`reportMicrophoneError()`（Audience）](../audience/rtm.ts#L221)

模块：Host/Audience `rtm.ts`。仅当本地麦克风 AudioTrack 不存在，或底层 `MediaStreamTrack` 非 live / 处于 muted 时，增量调用 `presence.setState({ microphoneError: "true" })`。本地 AudioTrack 为 live 且未 muted、只是 RTC publish 失败时不调用本函数；麦位归属不回滚。

### [`clearMicrophoneError()`（Host）](../host/rtm.ts#L273) / [`clearMicrophoneError()`（Audience）](../audience/rtm.ts#L226)

模块：Host/Audience `rtm.ts`。麦克风重试成功且仍在麦位时，增量调用 `presence.setState({ microphoneError: "false" })`。

### [`clearSeatMediaState()`](../audience/rtm.ts#L231)

模块：Audience `rtm.ts`。主动下麦或被迫下麦后调用 `presence.removeState({ states: ["muted", "microphoneError"] })`，删除两个麦位媒体状态；保留 `displayName`。

## 排麦申请

### [`requestSeat(hostUserId, request)`](../audience/rtm.ts#L236)

模块：Audience `rtm.ts`。固定向 Host UID 发布 `channelType=USER` 的 P2P `seat.request`，不得使用房间 `MESSAGE`；payload 只包含 `requestId` / `seatId`。业务桥接必须在第一次 publish 前同步设置 `waitingSeatId`，阻止快速连点产生多个 requestId；publish 超时、目标不在线或其他 API 失败时回滚等待态，并在房间视图 toast“Host 不在线”（存在 Presence nickname 时使用该昵称）。Host 暂时离开时 UI 禁用“申请上麦”，title 显示“房主暂时离开，无法处理上麦申请”，业务方法也拒绝调用。Host 用消息 publisher UID 调用 `getNickNameByUid()` 取 nickname。

### [`approveSeatRequest(input)`](../host/rtm.ts#L278)

模块：Host `rtm.ts`。只增量写入 `seats` metadata，不发 `seat.approved` P2P。Audience 消费 Storage 全量事件后，根据自己的 UID 出现在麦位中判定上麦成功。

### [`rejectSeatRequest(targetUserId, requestId, seatId)`](../host/rtm.ts#L283)

模块：Host `rtm.ts`。只向目标 Audience 发送 P2P `seat.rejected`，不写 Storage。

## 上麦邀请

### [`inviteToSeat(targetUserId, invitationId, seatId)`](../host/rtm.ts#L288)

模块：Host `rtm.ts`。发送 `channelType=USER` 的 P2P `seat.invited`。publish 超时、目标不在线或其他 API 失败时，业务桥接在房间视图 toast“<nickname> 不在线”。

### [`acceptSeatInvitation(hostUserId, invitationId, seatId)`](../audience/rtm.ts#L244)

模块：Audience `rtm.ts`。向 Host 发送 P2P `seat.invitation.accepted`，payload 不携带 nickname。Host 用 publisher UID 调用 `getNickNameByUid()`。

### [`rejectSeatInvitation(hostUserId, invitationId)`](../audience/rtm.ts#L256)

模块：Audience `rtm.ts`。向 Host 发送 P2P `seat.invitation.rejected`。

## 麦位生命周期

### [`updateSeats(seats)`](../host/rtm.ts#L236)

模块：Host `rtm.ts`。只增量写入 `seats` metadata。业务桥接层把所有读取并改写 `seats` 的操作放入独立串行队列，避免同一 key 的本地并发覆盖。

### [`leaveSeat(hostUserId, seatId)`](../audience/rtm.ts#L261)

模块：Audience `rtm.ts`。向 Host 发送 P2P `seat.left`。

## 房间内容与治理

### [`updateAnnouncement(text)`](../host/rtm.ts#L231)

模块：Host `rtm.ts`。只增量写入 `announcement` metadata。公告不进入麦位或强制静音队列，可立即写入。

### [`updateForcedMutedUsers(userIds)`](../host/rtm.ts#L244)

模块：Host `rtm.ts`。只增量写入 `forcedMutedUserIds` metadata。业务桥接层为该 key 使用独立串行队列，不阻塞 `seats` 或 `announcement`。

### [`kickMember(targetUserId)`](../host/rtm.ts#L293)

模块：Host `rtm.ts`。只发送 P2P `member.kick`。业务桥接并行清理麦位；P2P 失败时提示并按目标 UID 保存待重发动作，目标 REMOTE_JOIN 时自动重发。治理 P2P 不进入数据流。

### [`banMember(targetUserId)`](../host/rtm.ts#L298)

模块：Host `rtm.ts`。只发送 P2P `member.ban`。业务桥接的 `banMember()` 并行更新目录 `banUserIds`、清理麦位并发送 P2P。P2P 失败不回滚其他动作，显示提示并按目标 UID 保存待重发动作；目标 REMOTE_JOIN 时自动重发。治理 P2P 不进入数据流。

### [`dissolveRoom()`](../host/rtm.ts#L303)

模块：Host `rtm.ts`。向房间发布 `room.dissolved`。业务桥接先把目录写为 inactive；发布成功或失败后都清理实际房间 Metadata、执行 RTC leave 与 RTM unsubscribe，最后按 hostUserId、roomId 与 majorRevision 条件删除目录记录。实际房间清理间隔 300ms 最多尝试三次；实际房间或目录清理失败时保留重试入口，重试只补做未完成部分。Audience 收到该消息或空的实际房间 Metadata 后退订。

## 公屏互动

### [`sendChatMessage(text)`（Host）](../host/rtm.ts#L308) / [`sendChatMessage(text)`（Audience）](../audience/rtm.ts#L266)

模块：Host/Audience `rtm.ts`。发送房间消息 `chat.message`，payload 只携带文本。内置 Emoji 选择器插入的是 Unicode 字符，可与文字组合，仍通过本函数发送，不新增消息 type。接收方用 publisher UID 调用 `getNickNameByUid()`。

### [`sendGiftMessage()`（Host）](../host/rtm.ts#L313) / [`sendGiftMessage()`（Audience）](../audience/rtm.ts#L271)

模块：Host/Audience `rtm.ts`。发送房间消息 `gift.sent`，value 固定为 `🎁`，不携带 nickname。

### [`sendHeartMessage()`（Host）](../host/rtm.ts#L318) / [`sendHeartMessage()`（Audience）](../audience/rtm.ts#L276)

模块：Host/Audience `rtm.ts`。发送房间消息 `emoji.reaction`，value 固定为 `❤️`，不携带 nickname。

### `clearRoomData()`（Host）

模块：Host `rtm.ts`。在解散确认后阻止该实例继续写入房间 Metadata，等待已发起的写入结束，再调用 `storage.removeChannelMetadata(roomId, "MESSAGE")` 清理实际房间的全部四项数据，记录真实 API 成功或失败。重复进行中的清理复用同一 Promise；失败时间隔 300ms 最多尝试三次，仍失败则保留再次清理入口。Audience 不执行数据删除。

## 数据流观测

### [`getTraces()`（Host）](../host/rtm.ts#L323) / [`getTraces()`（Audience）](../audience/rtm.ts#L281)

模块：Host/Audience `rtm.ts`。返回当前角色 RTM trace 的只读快照。

### [`subscribeTraces(listener)`（Host）](../host/rtm.ts#L329) / [`subscribeTraces(listener)`（Audience）](../audience/rtm.ts#L287)

模块：Host/Audience `rtm.ts`。订阅 trace 变化，并返回退订函数。

### [`clearTraces()`（Host）](../host/rtm.ts#L335) / [`clearTraces()`（Audience）](../audience/rtm.ts#L293)

模块：Host/Audience `rtm.ts`。只响应用户点击数据流面板“清空”；业务流程不得调用。

页面生命周期内 trace 只追加、不自动截断。暂时离开、解散、被踢、被封禁和 client 切换都保留已经出现过的平台/角色 trace source；只有页面刷新或场景组件真正卸载会重建数据流，用户也可通过“清空”显式清除所有累计 source。

事件 trace 固定按“`EVENT`、事件名、SDK `eventType` tag、详情”展示。SDK 的 `REMOTE_STATE_CHANGED.stateChanged` 是最新完整 State，业务层必须与旧 State 比较后只展示变化字段；例如只增量设置 `microphoneError=true` 时，即使事件同时携带未变化的 `muted=true`，详情也只能是 `Emma_301 (audie…7890) microphoneError=true`。删除字段显示 `key=已删除`。仅携带 `displayName` 的 API 或事件也必须保留详情行。`REMOTE_JOIN` / `REMOTE_LEAVE` / `REMOTE_TIMEOUT` / `REMOTE_STATE_CHANGED` 都展示 Presence nickname 和缩写 UID；Host 缺失 nickname 时显示 `Host`，其他用户缺失 nickname 时只显示缩写 UID。Storage `SNAPSHOT` 和 `UPDATE` 都展示 `hostUserId`、`announcement`、`seats`、`forcedMutedUserIds` 四项全量 Metadata K-V，不做 diff；初始化 Metadata 的 API trace 同样展示实际写入的四项完整内容，不使用 `initialize`。语聊房不记录、不消费 Presence `INTERVAL`。事件详情由业务 store 基于唯一状态生成，`onRtmEvent.ts` 负责按“先 trace、后 consume”的顺序写入，`rtm.ts` 与 `onRtmEvent.ts` 都不缓存 nickname。后续增量 API trace 只展示本次调用写入或删除的业务字段；频道类 API 同时显示频道短标识，`presence.setState` 展示本次写入的全部字段，`presence.removeState` 展示删除的 key，`updateSeats` 只展示发生变化的麦位。`rtm.publish` 的 USER／MESSAGE 类型位于首行 tag，第二行只显示目标／频道与业务参数。完整可复用规则见[《数据流看板 API 与 Event 展示规范》](../../../shared/timeline/数据流看板-API-与-Event-展示规范.md)。

## Presence 事件消费

### [`getNickNameByUid(userId)`](../event-driven-single-room-client.ts#L337)

模块：业务桥接 store。从 Presence `uid → displayName` 映射读取 nickname；不发 RTM 请求，不使用消息 payload 或 Storage `seat.displayName` 作为权威来源。展示层需要名称但本函数返回空时，通过独立的展示函数降级为省略后的 UID。

### [`handlePresenceEvent(event)`](../event-driven-single-room-client.ts#L613)

模块：业务桥接。只负责按 `eventType` 分发，不直接修改具体 store 字段。

### [`handlePresenceSnapshot(event)`](../event-driven-single-room-client.ts#L711)

全量替换在线 UID、nickname、`muted` 和 `microphoneError` store。缺失 nickname 时不保留旧映射；缺失本端 `muted` 时默认 `false`；缺失远端 `muted` / `microphoneError` 时从对应 store 删除，展示层按 `false` 处理。

### [`onMemberJoined(userId, state)`](../event-driven-single-room-client.ts#L734)

增量加入在线 store；拿到 nickname 后生成“Alice_037 加入了房间”系统消息。

### [`onMemberLeft(userId)`](../event-driven-single-room-client.ts#L756)

从在线 store 和 nickname 映射删除成员，生成离开系统消息。若离开者是 Host，只把 `hostTemporarilyAway` 置为 true，Host 麦位状态词显示 `AWAY`（图标 title「房主暂时离开」），成员保持订阅并继续互动；不结束 active 房间。

### [`onMemberStateChanged(userId, state)`](../event-driven-single-room-client.ts#L776)

更新 nickname、静音状态和 `microphoneError`；若 JOIN 早于 nickname 到达，在此补发加入系统消息。任一端都用该状态为对应麦位显示或清除麦克风异常标识。

### [`handlePresenceInterval(interval)`](../event-driven-single-room-client.ts#L806)

批量分发 join / leave / timeout，复用上述成员消费函数。

## Storage 事件消费

### [`handleRoomMetadataChanged(result, eventType)`](../event-driven-single-room-client.ts#L590)

Storage `UPDATE` / `SNAPSHOT` 都携带完整的最新房间权威信息。该函数解析完整结果、校验 `majorRevision`，然后把最新字段值直接分发给对应 store update，不在事件分发层拼接增量状态。

### [`handleSeatsChanged(seats)`](../event-driven-single-room-client.ts#L943)

直接用 Storage 事件携带的最新完整 `seats` 替换麦位 store，清理排麦列表、收敛 Audience RTC 麦克风，并由 store 内部与当前麦位对比生成上麦/下麦系统消息。Audience 正在申请的麦位若被其他 UID 占用，立即清除等待态并 toast“上麦申请被拒绝”；当前邀请对应的麦位一旦被任意 UID 占用，立即清除邀请，隐藏接受/拒绝入口。首次权威快照只建立基线，不把快照里已经在麦位的成员当作新上麦；只有入房后的变化才生成系统消息。事件消费函数不接收 `previousSeats`。

### [`handleAnnouncementChanged(text)`](../event-driven-single-room-client.ts#L983)

更新房间公告 store。

### [`handleForcedMutedUsersChanged(userIds)`](../event-driven-single-room-client.ts#L987)

更新强制静音 store，并让本端 RTC 麦克风收敛到最终状态。

### [`handleHostChanged(hostUserId)`](../event-driven-single-room-client.ts#L991)

更新/校验 Host 身份；Host 页面收到不同 Host UID 时报错。

## Message 事件消费

### [`handleMessageEvent(envelope, context)`](../event-driven-single-room-client.ts#L811)

只按消息 type 分发到以下函数，不直接写业务 store。

### [`onSeatRequest(envelope, context)`](../event-driven-single-room-client.ts#L834)

Host 新增或去重排麦申请，nickname 通过 `getNickNameByUid(context.publisher)` 获取，并在房间视图显示 3 秒“Emma_301 申请 2 号麦位”toast。每条申请从 Host 收到消息起倒计时 30 秒，列表逐秒展示剩余时间；到期未处理则自动删除。审批、拒绝、成员离开、麦位被占用或房间离开时同步清理对应 timer。

### [`onSeatInvitationAccepted(envelope, context)`](../event-driven-single-room-client.ts#L854)

Host 通过 `getNickNameByUid(context.publisher)` 获取 nickname，计算新麦位归属并调用 `updateSeats()`。

### [`onSeatInvitationRejected(context)`](../event-driven-single-room-client.ts#L868)

Host 显示“拒绝邀请”业务反馈。

### [`onSeatLeft(context)`](../event-driven-single-room-client.ts#L872)

Host 删除该 Audience 的麦位归属，并通过 `updateSeats()` 写入 Storage。`onRtmEvent.ts` 必须先记录收到的 `message seat.left <麦位> from <nickname>` 事件，再调用 store listener 返回的 `consume`，因此数据流顺序固定为 message → `storage.setChannelMetadata` → Storage `UPDATE`。

### [`onSeatRejected()`](../event-driven-single-room-client.ts#L876)

Audience 清除等待态并显示被拒绝反馈。

### [`onSeatInvited(envelope)`](../event-driven-single-room-client.ts#L882)

Audience 保存待处理邀请，UI 在公屏顶部显示具体麦位号及接受/拒绝入口，并把公屏滚到顶部以确保操作可见；后续有新的公屏消息时恢复滚动到底部。

### [`onMemberKicked()`](../event-driven-single-room-client.ts#L890)

Audience 执行 RTC leave → RTM unsubscribe，保留 unsubscribe trace，进入被踢结果页。

### [`onMemberBanned()`](../event-driven-single-room-client.ts#L894)

Audience 执行 RTC leave → RTM unsubscribe，保留 unsubscribe trace 并进入封禁结果页。

### [`onRoomDissolved()`](../event-driven-single-room-client.ts#L899)

Audience 执行 RTC leave → RTM unsubscribe，保留 unsubscribe trace 并进入“房间已解散”结果页；重连后收到空的实际房间 Metadata 进入同一结果路径。

### [`onChatMessage(envelope, context)`](../event-driven-single-room-client.ts#L904)

通过 `getNickNameByUid(context.publisher)` 解析发送方，追加普通公屏消息。message 事件 trace 同时展示文本内容，例如 `chat.message from Host: 😱😏😔🤔🤒😒`。

### [`onGiftMessage(envelope, context)`](../event-driven-single-room-client.ts#L908)

通过 `getNickNameByUid(context.publisher)` 解析发送方，追加礼物公屏消息。

### [`onHeartMessage(envelope, context)`](../event-driven-single-room-client.ts#L912)

通过 `getNickNameByUid(context.publisher)` 解析发送方，追加爱心公屏消息。

## 名称目录

名称目录的独立 Host/Audience 适配器、CAS 函数与快照准入详见[共享目录说明](./按名称加入与共享目录.md)。它与本文件的实际房间四 key 协议分属两个频道，共用同一个页面 client。
