# Agent UI 设计规范整理

> 整理日期：2026-11-06。来源为 Agent UI 文档站公开发布的 [design.md](https://agent-ui-theta-drab.vercel.app/agent-docs/design.md)、[website.md](https://agent-ui-theta-drab.vercel.app/agent-docs/website.md)、[basic.md](https://agent-ui-theta-drab.vercel.app/agent-docs/basic.md)、[components.md](https://agent-ui-theta-drab.vercel.app/agent-docs/components.md) 与站点构建产物中的 `--ds-*`／`--aw-*` token。源码仓库 `shczhen/agent-ui` 未公开，本文不复制其源码。
>
> 本文只是参考摘要，不是本仓库的实现规范。本仓库当前规范仍为 [墨 · Ink 设计交接](../rtm-experience-hall/README.md)，对齐 Agent UI 的修订提案见该文件的「v2.0 修订提案」一节。

## 体系结构

Agent UI 是「Agora family」：一套调色与交互语言，三种材质表达。

| 层 | 作用 | 与本项目的关系 |
| --- | --- | --- |
| Agora Website foundation | 品牌 token（`--ds-*`）与上下文角色（`--aw-*`），`html.agora-website[data-appearance]` 切换浅深 | **可对齐**：颜色、字号、间距、动效、焦点 |
| Basic / Default | 默认产品控件：Button、ArrowAction、SegmentedControl、Tabs、Accordion、CopyField、Switch、InlineConfirm、CommandMenu | **可对齐**：控件尺寸、状态、反馈规则 |
| Liquid Glass / Atmospheric Film | 独立材质系统，含对话、Run、Approval、Artifact 等区块 | 不采用 |
| Agent Signal | 括号脸 + 点阵波形的活动指示（Canvas2D） | 不采用；本项目没有 Agent 状态 |

核心原则：

- **材质边界**：共享角色色与时序把家族连起来，各成员保留自己的材质、字体与几何。
- **权威文字**：装饰性信号不能代替可读的状态文字。
- **状态归宿主**：组件不持有业务状态、SDK、媒体设备，不写全局主题。

## 颜色

上下文角色（组件只引用 `--aw-*`）：

| 角色 | 深色（默认） | 浅色 | 用途 |
| --- | --- | --- | --- |
| background | `#000000` | `#fcf9f8` | 页面底 |
| surface | `#0a0a0a` | `#ffffff` | 卡片、面板 |
| raised | `#1a1a1a` | `#f1f0f0` | 次级按钮、输入、凸起面 |
| hover | `#242424` | `#e7e5e5` | 悬浮底 |
| foreground | `#fcf9f8` | `#0f0f0f` | 正文、主按钮底 |
| muted | `#b3b3b3` | `#626262` | 次要文字、quiet 按钮 |
| line | `#383838` | `#d6d6d6` | 常规边界 |
| line-strong | `#626262` | `#8a8a8a` | 强调边界 |
| signal | `#00c2ff` | `#075c9a` | 交互信号、链接、主按钮悬浮 |
| focus | `#a0faff` | `#075c9a` | 焦点环 |

- 主色在深色下是青色、在浅色下是深蓝，用于信号、交互与焦点。主操作静止时依靠前景／背景反差，悬浮时才转成 signal。
- 辅助紫 `#c46ffb`／`#9443c7` 仅作点缀，不能替代活动色。
- 中性色只有黑、近黑、暖白三档平面加 muted；没有多级灰阶。
- 没有定义 success／danger 语义色，也没有品牌渐变。
- Forced Colors 下映射到系统色（Canvas、CanvasText、ButtonText、Highlight、LinkText）。

## 字体

- 字体：本地 MiSans Regular／Demibold，回退 `"Helvetica Neue", sans-serif`。字体文件与许可证随样式一起分发，文档本身不授予再分发权。
- 等宽：`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`。
- 字重：400 / 500 / 600。正文与按钮标签都是 **400**。

| 角色 | 字号 | 行高 | 字距 |
| --- | --- | --- | --- |
| hero | `clamp(3rem, 4.35vw, 4rem)` | 0.94 | -0.052em |
| display | `clamp(2.1rem, 3vw, 3rem)` | 0.98 | -0.045em |
| title | `clamp(1.4rem, 1.65vw, 1.75rem)` | 1.08 | -0.035em |
| body | 16px | 1.58 | 0 |
| small | 13px | 1.5 | — |
| label | 12px | 1.3 | 技术标签 0.08em |
| button | 13px | 1.3 | — |

阅读宽度：常规 55ch，最大 68ch。

## 布局、尺寸与间距

- 间距按 4px 节奏：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 / 96。
- 外壳最大宽度 100rem，页边 `clamp(24px, 4vw, 64px)`。
- 控件高度：`sm` 32 / `md` 40 / `lg` 48。`compact` 独立收紧内边距和分组间距。同一行控件统一尺寸；工具栏统一用 `size="sm" compact`。
- 标签 13px regular，图标 16px。
- 手机或粗指针下，操作目标不小于 **46px**；Switch 可见轨道更小，但命中区仍达到 46px。

## 形状与层级

- 圆角按角色选：technical 2px、editorial 22px、pill 全圆；Basic 控件 6px，分组选中略大。
- 静止时安静：结构主要靠明确边界与色调平面，阴影只用于选中指示和模态命令搜索。

## 动效与反馈

| token | 值 |
| --- | --- |
| fast / standard / slow | 200ms / 360ms / 600ms |
| ease-standard | `cubic-bezier(.22, .61, .36, 1)` |
| ease-enter | `cubic-bezier(.16, 1, .3, 1)` |
| ease-exit | `cubic-bezier(.4, 0, 1, 1)` |
| Basic 按压 | 140ms |

- **锚定控件**：悬浮只改变颜色、边缘和光；按压加内凹深度。控件的位置和尺寸始终不变。
- **反馈不挤布局**：busy 按钮保留标签占位并居中显示 spinner，可访问名称不变；InlineConfirm 预留行宽，触发与确认按钮同一原点。
- 文字与模态出现只做淡入，不模糊、不位移。
- Tabs 保留最小内容区（默认 6rem）；Accordion 从当前可见高度开始过渡，中途反转不重置。
- 悬浮动效只在支持 hover 的精细指针上生效；减少动态效果时移除过渡。

## 焦点与无障碍

- 焦点环 2px，偏移 3px，使用 focus 角色色。
- 一个操作区域只保留一个主要动作。
- 加载用 `busy`，结果用明确反馈说明；图标按钮必须有 `aria-label`。
- Enter／Space 触发按钮；CommandMenu、InlineConfirm 支持 Escape 并归还焦点。
- 主题需要设在 document 或 portal 宿主上，浮层才能继承。

## Button（Basic）

| prop | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `size` | `"sm" \| "md" \| "lg"` | — | 32 / 40 / 48px 桌面高度 |
| `compact` | boolean | false | 收紧留白，保留尺寸与触屏目标 |
| `variant` | `"primary" \| "secondary" \| "quiet"` | `"primary"` | 操作优先级 |
| `busy` | boolean | false | 进度图标并阻止重复触发 |
| `disabled` | boolean | false | 暂不可用 |
| `type` | `"button" \| "submit" \| "reset"` | `"button"` | 原生行为 |

深色外观的视觉映射：

| 变体 | 底色 | 文字 | 悬浮 |
| --- | --- | --- | --- |
| primary | foreground `#fcf9f8` | background `#000` | 底色转 signal `#00c2ff` |
| secondary | raised `#1a1a1a` | foreground | hover 底 |
| quiet | 透明 | muted `#b3b3b3` | hover 底 |

圆角 6px，横向 padding 16px，默认高度 40px。`ArrowAction` 是带出入箭头连续动效的主操作。
