# Agent 项目约定

本文件是本仓库唯一维护的 Agent 指令入口。只维护 `AGENTS.md`，不要求存在 `CLAUDE.md`，也不再执行双文件同步。其他 Markdown 是按下列索引读取的参考资料，不因为文件名包含 agent 就自动成为指令入口。

## 安全与语言

- 删除本次任务开始前已存在的代码、文件或目录，必须先获得用户确认；整理、重构和改名本身不构成删除授权。用户要求只取消 Git 跟踪时，必须保留本地原件。
- 未经用户明确要求，不得暂存、提交或推送，包括 `git add`、`git commit`、`git commit --amend`、`git push`。保留用户已有的工作区和暂存区修改。
- 与用户对话、文档、UI 文案和错误提示统一使用简体中文；代码标识符、类型名、代码注释、路径、命令和 API 字面量保持英文。
- 不提交真实 App ID、App Certificate、token、浏览器登录状态或私钥；本项目不接收 App Certificate，不生成 token，不添加硬编码凭证兜底。

## 开始任务时必读

- [领域文档约定](docs/agents/domain.md)及根目录 [CONTEXT.md](CONTEXT.md)：沿用现有术语，存在相关 ADR 时一并阅读。
- [本地 Issue 约定](docs/agents/issue-tracker.md)和 [Triage 标签](docs/agents/triage-labels.md)：需要拆分任务或更新票据时按该约定执行，不依赖 Claude 或特定技能命令。
- 修改语聊房前，读取[场景 README](src/scenes/voice-room/README.md)和[模块与实现约束](src/scenes/voice-room/docs/语聊房模块与依赖关系.md)；协议变化还要核对[功能映射](src/scenes/voice-room/docs/语聊房功能与-rtm-函数映射.md)及[事件与时序](src/scenes/voice-room/docs/语聊房功能底层-RTM-API-事件与时序.md)。
- 修改 1V1 呼叫邀请前，读取[场景 README](src/scenes/one-to-one-call/README.md)、[模块依赖](src/scenes/one-to-one-call/docs/1v1呼叫邀请模块与依赖关系.md)和[状态与时序](src/scenes/one-to-one-call/docs/1v1呼叫邀请状态流转与时序.md)。
- 修改数据流展示前，读取[API 与 Event 展示规范](src/shared/timeline/数据流看板-API-与-Event-展示规范.md)。修改视觉前，读取[当前设计规范](design/rtm-experience-hall/README.md)，对照 `Design System.dc.html` 和 `Lab.dc.html`。

## 仓库与公共架构

- 只有一个应用、一个 `index.html`、一份 `package.json` / Vite / Playwright 配置和一套根 `e2e/`；不要新增并行应用或多入口。
- `src/` 的顶层目录只有 `app/`、`scenes/`、`shared/`、`test/`。当前实现语聊房与 1V1 呼叫邀请，另外五个导航入口待开放；保留已有场景 URL 兼容。
- 全站样式只有 `src/app/styles.css`；颜色来自浅深主题的 `--ink-*` 语义 token，不新增 CSS 文件或 CSS-in-JS。已确认的视觉变化同步设计 README、设计系统和主原型；Concept 与 Trace Palettes 只作历史参考。
- 场景导航使用整页跳转，不在同一 JS 运行时切换业务场景或缓存跨场景 Session。每个页面只运行当前场景的一个 RTM Client；多端联调使用不同标签页或设备。
- SDK listener 必须在 `login()` 前注册。同页登录失败重试复用原 Client，Strict Mode 模拟卸载不注销；真正卸载或 `pagehide` 时幂等清理并尽力 `logout()`。历史缓存恢复时重新加载，普通标签页切换不触发退出。
- 配置顺序是 `window.__ENV__.appId` → `import.meta.env.VITE_APP_ID` → 未配置引导；启动只读取一次，页面注入必须先于入口 bundle。不改变 E2E mode 的 `envDir: false`，避免读取本机 `.env.local`。
- 数据流只呈现 RTM，不采集 RTC。共享组件只展示配置、进度和 trace，不直接操作 SDK；清空数据流不能改变业务状态或体验进度。
- RTM SDK 使用 `linkState`，不使用废弃的 `status`；token 事件仅把 `WILL_EXPIRE` 当作即将过期。
- 踢出、封禁、强制麦控和 Demo 名称目录都只是客户端协作，不构成鉴权边界。生产环境的身份、目录、准入、治理授权与 token 必须交给客户 App Server。

## 场景关键约束

### 语聊房

- 页面级 `AppRtmSession` 独占 Client、登录和连接事件；Host/Audience 的 `rtm.ts` 只依赖页面操作端口，不自行创建或登录 SDK。角色 RTM 刻意独立，不抽跨角色基类，公开函数按用户功能命名。
- 实际房间的 Storage 只有 `hostUserId`、`announcement`、`seats`、`forcedMutedUserIds` 四项，由 Host 单写、各端消费全量事件；Presence 是在线成员与 nickname 的来源。角色 RTM 不复制业务 store 或昵称映射。
- 实际房间订阅 Message、Presence、Metadata，`withLock: false`；不调用实际房间 `getChannelMetadata()`、`presence.getOnlineUsers()`，不使用 Lock。Demo 目录仅在入房前读写，不订阅、不进数据流，生产时必须替换。
- 消息必须校验来源、目标、版本、TTL 并按 ID 去重；普通房内消息不自动重试。排麦请求只发 Host 的 USER P2P，不能广播到房间。
- 麦位归属只由 Storage 决定，RTC 发布失败不能回滚麦位；自主静音和设备异常由 Presence 协作。Host 暂时离线不等于解散。
- `subscribe()` 成功不等首快照；断线后的 Audience 要等有效的实际房间 Storage 事件才能恢复交互，不能仅凭 `CONNECTED` 撤罩，也不重复订阅或补读快照。
- 页面级数据流保留登录、连接和终止退订；语聊房角色 trace 及其 source 在当前页面只追加，不自动截断或因离房移除，只有用户清空时才清空。细节见模块文档第 7 节。

### 1V1 呼叫邀请

- Demo 的信令路径是 `App → rtm.ts → invitation/`，页面会话持有唯一 Client。完整 `invitation/` 可接入客户已有的已登录 Client，不自行登录、注销或管理 RTC。
- 邀请实例、Caller/Callee 状态、ACK、重试和绝对截止由邀请插件管理；App 管理单通媒体、静音、挂断与资源清理。媒体结束不得回写邀请终态，不能把 SDK publish 成功当作对端已接受。
- 不把语聊房的角色拆分、Storage 或房间协议直接推广为所有场景的实现要求；以各场景正式文档为准。

## 命令与验证

要求 Node.js 20 以上。在仓库根目录执行：

```bash
./start-demo.sh
./start-demo.sh --http
./start-demo.sh --both
./start-demo.sh --check
npm run dev
npm run dev:https
npm run build
npm test
npm run test:e2e
npx vitest run src/scenes/voice-room/test/host/rtm.test.ts
npx playwright test e2e/lab.spec.ts --project=desktop-chromium
```

- 启动脚本默认局域网 HTTPS 8080、不打开浏览器；`--http` 为 HTTP 8080，`--both` 为 HTTP 8080 与 HTTPS 8443。HTTPS 用 `mkcert`，脚本不得自动安装根 CA；用户自行执行 `mkcert -install`，其他设备另行信任，`.cert/` 始终忽略。
- Vitest 使用 jsdom 与 Testing Library。场景测试及辅助放 `src/scenes/<scene>/test/`，按源模块保留子目录；全局 setup 在 `src/test/`，仓库约束测试在 `tests/`，E2E 在 `e2e/`。
- 语聊房角色 RTM port 替身用于断言原子调用；`createVoiceRoomFakes()` 用于渲染场景，必须阻止真实联网。两者职责不同，不互相替代。
- 浏览器测试默认无头，除非用户明确要求可视化；Playwright 自动在 4173 端口启动隔离的 E2E mode，使用占位凭证和 RTM/RTC 替身，不代表真实 Agora 连通性已验收。人工真实音频联调必须戴耳机。
- CI 运行单元测试、构建与 E2E。`package-lock.json` 必须包含跨平台可选原生依赖；SDK 从 npm 安装，`vendor/` 只是本地历史副本，不随仓库发布。

## 文档与任务组织

- 根 `README.md` 介绍整个 Demo；各场景的功能、体验与源码入口放 `src/scenes/<scene>/README.md`，正式协议和回归文档放该场景 `docs/`。修改行为时同步相关现行文档，不在多个入口重复维护完整协议。
- 公开文档只描述当前有效方案，准确区分 API 成功、业务状态与媒体结果；回归文档写清环境、步骤和预期结果。历史票保留原始结论，但必须标识历史性质并指向现行文档，不能覆盖当前规范。
- 根 `docs/` 按 `.gitignore` 白名单保留 Agent 约定、领域 ADR 和当前规格；历史实施票目录只留本地，不纳入 Git。临时说明、研究和其他本地资料继续忽略。新增需公开的根文档时检查白名单，场景 `docs/` 不受根目录规则影响。
- 常规仓库清理不新增审计报告、清理清单或过程记录，除非用户明确要求；只做必要的配置、版本管理调整和结果校验。
- 需要拆票时使用 `docs/scratch/<feature-slug>/spec.md` 与 `issues/<NN>-<slug>.md`，用 `Blocked by` 声明依赖，不另写 plan 文档；简单修正不要求新建整套票据。
- `docs/superpowers/{specs,plans}/` 是本地历史资料，保留、不新增。当前维护规格在 `docs/scratch/rtm-demo-lab/spec.md`，历史资料不作为现行接入或验收依据。
