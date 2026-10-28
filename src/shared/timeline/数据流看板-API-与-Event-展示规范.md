# 数据流看板 API 与 Event 展示规范

更新日期：2026-09-16

本文定义 RTM Demo 数据流看板的通用展示契约，并用语聊房场景给出完整示例。其他 Demo 复用时保留通用字段和格式，只替换频道短标识和业务摘要生成器。

## 1. 条目结构

看板只采集 RTM，不采集 RTC。每条记录都是 `TraceEntry`：

| 字段 | API | Event | 展示规则 |
| --- | --- | --- | --- |
| `at` | 必填 | 必填 | `HH:mm:ss.SSS` |
| `kind` | `api` | `event` | 显示为 `API` 或 `EVENT` |
| `name` | API 方法名 | SDK 事件入口名 | 例如 `rtm.publish`、`presence` |
| `eventTag` | publish 的 `USER` / `MESSAGE` 类型 | 事件类型 | 例如 `USER`、`MESSAGE`、`REMOTE_JOIN`、`UPDATE` |
| `summary` | 本次调用参数的可读摘要 | 已校验事件的业务摘要 | 第二行完整展示并自动换行，原生 `title` 同时保留全文 |
| `durationMs` | 必填 | 不使用 | 用单调高精度时钟计算 |
| `errorCode` / `errorMessage` | 失败时填写 | 不使用 | 与 `summary` 同行展示，不覆盖调用参数 |
| `uid` / `role` / `seq` | 必填 | 必填 | 用于来源归并和稳定排序；当前 UI 隐藏技术 UID badge |

数据流按时间从新到旧展示。同一毫秒、同一来源按较大 `seq` 在前。

## 2. 通用格式规则

- 频道名使用可识别的短标识。语聊房 `voice-room-e1fa5e28-7306-4686-a206-ec118b17d2e9` 显示为 `voice-room-...-d2e9`。
- 针对 Channel 的 API 在摘要前显示 `<channel>: `；`subscribe` / `unsubscribe` 的摘要只显示频道短标识。
- USER publish 在首行显示 `USER` tag，第二行显示目标但不显示本端发送者：`to <目标名称> <type> <业务参数>`。
- MESSAGE publish 在首行显示 `MESSAGE` tag，第二行显示频道和范围但不显示本端发送者：`<channel>: to ALL <type> <业务参数>`。
- Event 里的成员名称优先来自 Presence nickname。Host 缺失 nickname 时显示 `Host`，其他用户显示缩写 UID。
- 第二行只有房间名和 UID 使用约定的缩写形式，其余业务内容完整展示；空间不足时换行，不使用省略号截断。
- 业务摘要只解析经协议校验的字段，不把原始 JSON 直接塞入看板。

## 3. API 展示表

下表中的“调用示例”表示底层 SDK 调用，“看板展示示例”表示 API 条目的 `name` 和 `summary`。

| API | 调用示例 | 摘要取值 | 看板展示示例 |
| --- | --- | --- | --- |
| `rtm.login` | `client.login({ token })` | 不展示 token 或凭证；只显示耗时和失败信息 | `API  rtm.login  1935.3ms` |
| `rtm.subscribe` | `client.subscribe(roomId, { withMessage: true, withPresence: true, withMetadata: true, withLock: false })` | 频道短标识 | `API  rtm.subscribe  164.4ms`<br>`voice-room-...-d2e9` |
| `presence.setState` | `client.presence.setState(roomId, "MESSAGE", { displayName: "小明", muted: "false" })` | 频道 + 本次写入的全部字段 | `API  presence.setState  4.6ms`<br>`voice-room-...-d2e9: displayName=小明, muted=false` |
| `presence.removeState` | `client.presence.removeState(roomId, "MESSAGE", { states: ["muted", "microphoneError"] })` | 频道 + 本次删除的 key | `API  presence.removeState  0.4ms`<br>`voice-room-...-d2e9: muted, microphoneError` |
| `storage.setChannelMetadata` | `client.storage.setChannelMetadata(roomId, "MESSAGE", [{ key: "seats", value }])` | 频道 + 本次写入的 key/value 业务摘要 | `API  storage.setChannelMetadata  364.6ms`<br>`voice-room-...-d2e9: seats=2号麦 空` |
| `storage.setChannelMetadata` | `client.storage.setChannelMetadata(roomId, "MESSAGE", initialData, { majorRevision })` | 初始化调用展示实际写入的四项完整 Metadata | `API  storage.setChannelMetadata  363.0ms`<br>`voice-room-...-d2e9: hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, …, forcedMutedUserIds=空` |
| `storage.removeChannelMetadata` | `client.storage.removeChannelMetadata(roomId, "MESSAGE")` | 频道 + 清理意图 | `API  storage.removeChannelMetadata  2.1ms`<br>`voice-room-...-d2e9: 清理已解散房间数据` |
| `rtm.publish` USER | `client.publish(hostUid, envelope, { channelType: "USER" })` | 首行 `USER` tag；第二行目标名称 + 协议 type + 可读业务参数 | `API  rtm.publish  USER  59.4ms`<br>`to Host seat.request 2号麦` |
| `rtm.publish` USER | `client.publish(audienceUid, envelope, { channelType: "USER" })` | 同上 | `API  rtm.publish  USER  63.6ms`<br>`to 小明 seat.invited 2号麦` |
| `rtm.publish` MESSAGE | `client.publish(roomId, envelope, { channelType: "MESSAGE" })` | 首行 `MESSAGE` tag；第二行频道 + `to ALL` + 协议 type | `API  rtm.publish  MESSAGE  21.5ms`<br>`voice-room-...-d2e9: to ALL emoji.reaction` |
| `rtm.unsubscribe` | `client.unsubscribe(roomId)` | 频道短标识 | `API  rtm.unsubscribe  3.1ms`<br>`voice-room-...-d2e9` |

API 失败时仍保留上述参数摘要，并在同一详情行附加 `errorCode` 和 `errorMessage`。例如：

```text
API  rtm.publish  USER  61.8ms
to 小明 seat.invited 2号麦  -11033 USER_OFFLINE
```

## 4. Event 展示表

Event 条目的 `name` 是 SDK 事件入口，`eventTag` 是具体事件类型或消息范围。事件摘要在业务状态覆盖前生成，然后再执行业务消费。

| Event | 采集信息 | 摘要规则 | 看板展示示例 |
| --- | --- | --- | --- |
| `linkState` | `previousState`、`currentState`、`reasonCode` | 连接状态迁移 + 字符串 `reasonCode` | `EVENT  linkState  CONNECTED`<br>`CONNECTING→CONNECTED · LOGIN_SUCCESS` |
| `presence` `SNAPSHOT` | `snapshot[].userId`、`states.displayName` | 按快照顺序展示在线 nickname；空快照显示“暂无昵称” | `EVENT  presence  SNAPSHOT`<br>`小明, 小周` |
| `presence` `REMOTE_JOIN` | `publisher`、`stateChanged.displayName` | nickname + 缩写 UID；缺 nickname 时只显示 UID | `EVENT  presence  REMOTE_JOIN`<br>`小明 (audie…7890)` |
| `presence` `REMOTE_LEAVE` | `publisher` | 事件消费前取 nickname + 缩写 UID | `EVENT  presence  REMOTE_LEAVE`<br>`小明 (audie…7890)` |
| `presence` `REMOTE_TIMEOUT` | `publisher` | 与 `REMOTE_LEAVE` 相同 | `EVENT  presence  REMOTE_TIMEOUT`<br>`小明 (audie…7890)` |
| `presence` `REMOTE_STATE_CHANGED` | `publisher`、完整 `stateChanged` | nickname + 缩写 UID + 相对本地旧 State 真正变化的 key/value；删除显示 `key=已删除` | `EVENT  presence  REMOTE_STATE_CHANGED`<br>`小明 (audie…7890) muted=false, microphoneError=已删除` |
| `presence` `INTERVAL` | 不采集 | 语聊房使用实时 Presence 事件和 `SNAPSHOT`，不记录、不消费 `INTERVAL` | 不生成看板条目 |
| `storage` `SNAPSHOT` | `data.metadata` 的四项权威字段 | 展示全量 Metadata K-V，不显示 `initialize` | `EVENT  storage  SNAPSHOT`<br>`hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, …, forcedMutedUserIds=空` |
| `storage` `UPDATE` | `data.metadata` 的四项权威字段 | 不做 diff，每次展示全量 Metadata K-V | `EVENT  storage  UPDATE`<br>`hostUserId=Host, announcement=大家好, seats=1号麦 Host, 2号麦 小明, …, forcedMutedUserIds=小明` |
| `storage` 空 Metadata | `data.metadata={}` | 初始空快照显示 `Metadata=空`；已建立权威快照后的空数据显示“房间数据已清理” | `EVENT  storage  SNAPSHOT`<br>`Metadata=空` |
| `message` USER | `publisher`、信封 `type`、已校验 `payload` | type + 麦位等业务参数 + 发送者名称 | `EVENT  message  USER`<br>`seat.request 2号麦 from 小明` |
| `message` MESSAGE | `publisher`、信封 `type`、已校验 `payload` | 普通聊天追加文本；礼物、爱心不追加 payload 正文 | `EVENT  message  MESSAGE`<br>`chat.message from 小明: 💯` |
| `token` | `eventType` | `eventType` 作为 tag，不生成额外摘要；`WILL_EXPIRE` 另外触发页面错误提示 | `EVENT  token  WILL_EXPIRE` |

## 5. 语聊房不进入看板的操作

| 范围 | 不展示原因 |
| --- | --- |
| Demo-only 名称目录的 `getChannelMetadata` / `setChannelMetadata` / `removeChannelMetadata` | 目录只是无 App Server 时的 Demo 替代实现，不是客户应复制的 RTM 组合实践 |
| Demo-only 踢出、封禁治理 P2P | 生产应由客户 App Server 通过服务端 SDK 或 RESTful API 下发，不作为客户端最佳实践展示 |
| RTC join / publish / mute / leave | 看板的教学主线是 RTM，RTC 只是体验脚手架 |
| `rtm.logout` | 当前只在语聊房 SPA 真正卸载时执行，当前数据流源随场景一起卸载 |

## 6. 其他 Demo 复用清单

1. 复用 `TraceEntry` 字段和 API/Event 两种 `kind`，不向 UI 直接传原始 SDK 对象。
2. API 调用层负责耗时、失败和本次调用参数摘要；Event 业务层负责 nickname 和业务字段解析。
3. 频道类 API 始终带频道短标识；publish 的 USER／MESSAGE 类型放在首行 tag，第二行 USER 始终带 `to`，MESSAGE 始终带频道和 `to ALL`。
4. 事件先记录 trace，再执行业务消费，保证数据流顺序可解释。
5. 每个新场景明确自己的“不进入看板”边界，避免把脚手架或 Demo-only 机制当成产品最佳实践。
6. 为每种 API/Event 至少保留一个精确摘要测试，并用 E2E 验证看板最终文案。
