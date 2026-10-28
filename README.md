# RTM 场景实验室

[在线体验](https://rtm-demo.shengwang.cn/) · [GitHub 源码](https://github.com/AgoraIO-Community/RTM-Demo)

使用 Agora RTM Web SDK 演示业务信令与状态同步，并在页面数据流中展示真实的 RTM API 调用、事件、顺序和耗时。音频由 Agora RTC SDK 提供，数据流只呈现 RTM。

当前实现两个场景，另外五个导航入口（电商直播、在线课堂、虚拟世界、游戏互动、文档协同）为待开放占位页。

| 场景         | 体验内容                                                   | 使用与接入说明                                              |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 语聊房       | 按名称创建和加入、成员在线、排麦与邀请、消息、房间状态同步 | [语聊房 README](src/scenes/voice-room/README.md)            |
| 1V1 呼叫邀请 | 发起、接听、拒绝、取消邀请，以及真实音频、静音和挂断       | [1V1 呼叫邀请 README](src/scenes/one-to-one-call/README.md) |

场景 README 提供体验步骤和源码导航；各自的 `docs/` 保存功能映射、协议时序和回归流程。

## 快速开始

环境要求：Node.js 20 或更高版本。

```bash
npm install
cp .env.example .env.local
```

在 `.env.local` 中填写自己的 App ID，勿提交真实配置：

```dotenv
VITE_APP_ID=<你的 App ID>
```

本机启动：

```bash
npm run dev
```

打开 `http://127.0.0.1:8080/`，选择场景，按对应场景 README 使用两个独立页面或设备联调。没有配置 App ID 时显示配置引导，仍可访问导航和开发资源。**真实音频联调请戴耳机。**

### 局域网与 HTTPS

```bash
./start-demo.sh
./start-demo.sh --https
./start-demo.sh --http
./start-demo.sh --both
./start-demo.sh --check
```

| 命令                           | 行为                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `./start-demo.sh` 或 `--https` | 缺依赖时先安装，默认监听 `0.0.0.0`，启动 HTTPS 8080，不打开浏览器 |
| `--http`                       | HTTP 8080                                                         |
| `--both`                       | HTTP 8080 与 HTTPS 8443                                           |
| `--check`                      | 检查 Node 版本，并打印实际解析到的 SDK 版本                       |

`--no-open` 继续兼容，但默认已不打开浏览器。只允许本机访问时设置 `RTM_DEMO_HOST=127.0.0.1`。

跨设备使用麦克风、摄像头或剪贴板功能时应使用可信 HTTPS。HTTPS 模式要求安装 `mkcert`，由用户自行执行 `mkcert -install`；脚本不会自动安装根 CA。脚本为本机与发现的局域网 IPv4 生成 `.cert/dev.pem` 和 `.cert/dev-key.pem`，其他设备还需单独信任日志中打印的 `rootCA.pem`。不要提交证书、私钥或本地 CA。

## 配置与部署

App ID 只在应用启动时读取一次，优先级为：

```text
window.__ENV__.appId → import.meta.env.VITE_APP_ID → 未配置引导页
```

本地开发使用 `.env.local`；嵌入上层网站时可通过同步脚本注入配置。必须在应用入口 bundle 之前设置，应用不会监听之后的变化：

```html
<script>
  window.__ENV__ = { appId: "你的 App ID" };
</script>
<script type="module" src="/assets/index-xxxx.js"></script>
```

入口脚本文件名以 `npm run build` 的实际产物为准。App ID 应来自所使用项目的声网控制台；国内站与国际站项目不要混用。生产部署所需网络白名单应向声网确认，不能将本地研究记录当作完整的服务承诺。

### 鉴权模式

Token 服务需由客户自行实现，参考[声网 Token 工具与说明](https://console.shengwang.cn/tools/token)。

嵌入 iframe 的基础配置示例：

```html
<iframe
  src="https://rtm-demo.shengwang.cn/social/voice-room"
  allow="camera; microphone"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

上层页面需允许对应的媒体权限、存储访问及网络连接；缺少 `allow-same-origin` 的 sandbox 会限制存储访问。按实际部署配置 CSP 与权限策略，并验证目标浏览器中的登录和媒体行为。

## 运行与安全边界

- **一个页面只运行一个场景、一个 RTM Client。** 多角色联调使用不同页面。监听在登录前注册，同页登录重试复用 Client；场景导航整页加载，不缓存跨场景 Session。
- **离开页面的清理是尽力执行。** `pagehide` 或真正卸载时执行幂等清理和注销，异步请求不保证完成；对端仍需按场景的 Presence、截止时间等机制收敛。Strict Mode 模拟卸载不注销，普通标签页切换不退出。
- **Demo 不提供生产权限系统。** 语聊房名称目录、踢出、封禁和强制麦控只是客户端协作；生产环境的身份、房间查询、准入、治理授权和生命周期必须由客户 App Server 实现。
- **仓库不分发项目凭证。** `.env.example` 是空模板，不提交真实 App ID、App Certificate 或 token。不能将密钥放进浏览器。

主题偏好跨页面保留；数据流、体验进度和侧栏折叠状态随新页面重置。浏览器历史恢复缓存页面时重新加载；清空数据流不影响场景业务状态和本次体验进度。

## 开发与验证

```bash
npm run dev
npm run dev:https
npm run build
npm test
npm run test:e2e
npx playwright test e2e/lab.spec.ts --project=desktop-chromium
```

`dev` 使用本机 HTTP 8080；`dev:https` 使用 HTTPS 8080，需先由启动脚本生成证书。`build` 执行 TypeScript 检查和 Vite 单入口构建。单元测试使用 Vitest，浏览器测试使用无头 Playwright。

Playwright 自动在 4173 端口启动独立 `e2e` mode，不读取开发者的 `.env.local`；RTM 与 RTC 使用测试替身。**自动化通过不等于真实 Agora 连通性验收**，真实链路需配置有效项目并按场景回归文档验证。CI 在推送和 PR 时执行单元测试、构建与 E2E。

## 目录与文档

```text
index.html                    唯一应用入口
src/app/                      外壳、场景导航、配置、主题和唯一全站样式
src/scenes/voice-room/        语聊房、场景 README、正式 docs/ 与 test/
src/scenes/one-to-one-call/   呼叫邀请、场景 README、正式 docs/ 与 test/
src/shared/                   体验路径、RTM 数据流与 RTC 辅助
src/test/                     Vitest 全局 setup
tests/                        仓库形态与启动脚本测试
e2e/                          跨页面端到端测试及替身
design/rtm-experience-hall/    当前视觉规范、原型与历史设计探索
docs/agents/                  工具无关的领域、票据和分诊约定
```

- [数据流展示规范](src/shared/timeline/数据流看板-API-与-Event-展示规范.md)：其他场景接入 API/Event 看板时的通用契约。
- [AGENTS.md](AGENTS.md)：唯一维护的项目 Agent 指令入口，引用对应场景与工作流资料。
- [CONTEXT.md](CONTEXT.md)：共享领域术语；[当前规格](docs/scratch/rtm-demo-lab/spec.md)描述实验室公共外壳与语聊房运行契约。
- [设计规范](design/rtm-experience-hall/README.md)：当前视觉基线与设计包索引，历史探索不作为现行规范。
- [CHANGELOG.md](CHANGELOG.md)：版本变更记录。

根 `docs/` 只公开白名单内的维护资料；本地研究、临时清理记录和未选历史工作材料继续忽略。场景的正式 `docs/` 正常纳入版本管理，不受根目录忽略规则影响。

## SDK 来源与许可证

项目通过 npm 安装 `agora-rtm`（声明范围为 `^2.3.0`）和 `agora-rtc-sdk-ng`，实际版本与完整性由 `package-lock.json` 锁定。本机 `vendor/` 历史副本不参与构建，也不随仓库分发。

本仓库自身的 Demo 代码与文档采用 MIT，见 [LICENSE](LICENSE)。Agora SDK 各自遵循其自身许可证，不属于本仓库 MIT 许可证覆盖范围。
