# 1V1 呼叫邀请

本场景使用 RTM USER 消息协调呼叫邀请，邀请接受后由 App 建立 RTC 音频。每个页面只有一个 RTM Client；邀请信令和媒体会话相互独立，数据流只展示 RTM。

项目安装、App ID 配置和 HTTPS 启动见[根 README](../../../README.md)。

## 双页面体验

1. 使用相同 App ID，在两个独立页面或设备选择“1V1 呼叫邀请”。页面自动生成各自的呼叫 ID，可填写选填昵称。
2. 在被叫页面复制呼叫 ID，在主叫页面的“对方呼叫 ID”中输入，然后发起邀请。
3. 被叫可接听或拒绝，主叫可在等待期间取消。接听成功后进入音频连接阶段，媒体就绪后通话。
4. 通话中体验静音、取消静音与挂断，在数据流观察邀请消息和 SDK 事件。真实音频联调请戴耳机，跨设备使用可信 HTTPS。

呼叫 ID 是本端身份，单次邀请另有独立的 `callId`。SDK `publish()` 成功不代表对端已接听，也不代表 RTC 音频已经连接。

## 信令与媒体的边界

- `invitation/` 管理每次邀请的 Caller/Callee 实例、消息协议、重试、绝对截止、接听 ACK 和终态，不管理 RTC。
- `rtm.ts` 中的 `CallRtm` 为 Demo App 提供发起、接听、拒绝、取消等业务函数，以及只读邀请快照与状态事件。
- `app-rtm.ts` 持有页面唯一 RTM Client，负责登录、监听、发布适配和数据流；不为每次邀请创建新 Client。
- `app/` 根据邀请结果管理 App 通话策略；`rtc/` 管理音频、麦克风、媒体等待、挂断和资源释放，并使用共享 RTC 辅助。

插件可以管理多条邀请，Demo App 同时只管理一通媒体。接受、拒绝、取消或失败后的邀请保留各自终态；媒体结束不把已完成的邀请重置成空闲。详细枚举、截止和 ACK 时序以[状态流转与时序](./docs/1v1呼叫邀请状态流转与时序.md)为准。

## 两种接入路径

### 阅读或修改 Demo

信令调用路径为：

```text
OneToOneCallScene → AppCallController → CallRtm → invitation/
                                                     ↓
                                    页面已登录 RTM Client
```

优先阅读 [rtm.ts](./rtm.ts)、[页面会话](./app-rtm.ts)、[App 通话控制器](./app/call-controller.ts)和[模块与依赖关系](./docs/1v1呼叫邀请模块与依赖关系.md)。不要把 Demo 的页面身份、数据流或 RTC 实现误认为邀请插件的必需依赖。

### 接入已有 RTM 应用

复制完整的 [invitation/](./invitation/index.ts)，传入已有的已登录 RTM Client 和与登录一致的 `userId`：

```ts
import { Invitation } from './invitation';

const invitations = new Invitation(rtmClient, { userId });
```

插件绑定自己的 `message` / `linkState` 监听，销毁时只解绑自身监听；Client 的创建、登录和注销仍由 App 管理。App 观察邀请状态后决定何时建立和结束自己的媒体会话。完整函数、事件和使用方式见[功能与 RTM 函数映射](./docs/1v1呼叫邀请功能与-rtm-函数映射.md)。

## 文档与验证

| 材料 | 内容 |
| --- | --- |
| [功能与 RTM 函数映射](./docs/1v1呼叫邀请功能与-rtm-函数映射.md) | 从用户功能查找业务接口、插件接口和信令实现 |
| [模块与依赖关系](./docs/1v1呼叫邀请模块与依赖关系.md) | 页面会话、调用适配、邀请插件与媒体层的职责 |
| [状态流转与时序](./docs/1v1呼叫邀请状态流转与时序.md) | Caller/Callee 状态、ACK、重试、截止与竞态处理 |
| [端到端回归流程](./docs/1v1呼叫邀请端到端回归流程.md) | 双页面验证步骤、预期结果与自动化覆盖 |

场景单元和组件测试位于 `test/`，按 `invitation/`、`app/`、`rtc/` 分组。E2E 使用 RTM/RTC 替身，不证明真实连通性；真实网络、设备权限和音频需按回归文档另行验收。

Token 服务需由客户自行实现，参考[声网 Token 工具与说明](https://console.shengwang.cn/tools/token)。
