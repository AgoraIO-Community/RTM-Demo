# Issue tracker：本地 Markdown

本仓库使用 `docs/scratch/` 下的 Markdown 跟踪功能规格和实施任务。这是项目组织约定，不取决于是否配置 Git remote，也不依赖 Claude、远端 issue 平台或特定技能命令。

## 文件与依赖

- 一个功能一个目录：`docs/scratch/<feature-slug>/`。
- 规格放在 `spec.md`；实施票一票一文件，放在 `issues/<NN>-<slug>.md`，编号从 `01` 开始，不将多张票合并。
- 用 `Blocked by: 02, 05` 声明同一功能内的前置票；无依赖写 `Blocked by: none`。
- 不另写独立 plan 文档，实施顺序由票据依赖表达。简单文档修正或局部改动不要求新建整套规格和票据。
- 评论追加到 `## Comments`，完成结论写入 `## Answer`，保留可追溯的决策和验证结果。

## 执行状态与分诊标签

这两类信息分别记录，不能共用同一个字段：

| 字段 | 取值 | 用途 |
| --- | --- | --- |
| `Status:` | `open`、`claimed`、`resolved` | 待处理、正在执行、已完成的执行状态 |
| `Triage:` | 见 [triage-labels.md](./triage-labels.md) | 是否需要评估、补充信息、由 Agent 或人工处理，以及不予处理 |
| `Type:` | `research`、`prototype`、`grilling`、`task` | 需要区分任务类型时使用 |

新票的最小示例：

```text
# 03 — 任务标题

Status: open
Triage: ready-for-agent
Blocked by: 02
```

开始执行前标为 `claimed`；完成并记录验证后标为 `resolved`。只有前置票全部 `resolved` 才解除阻塞。`wontfix` 表示不实施，不自动当作成功完成的前置任务；若后续任务仍依赖它，需先调整依赖或范围。

现有历史票可保留原字段与完成记录；只在重新启用或实际更新状态时按新格式整理，不批量伪造执行历史。分诊标签不表示验收已通过，`ready-for-agent` 也不是正在执行。

## 读取、认领与保留

- 用户给出路径或票号时读取对应文件；需要找下一项时，选择未完成、未认领且依赖已解除的票，优先较小编号。
- 如果已有 `map.md`，可继续作为决策与上下文索引；不要求为了使用票据先创建地图，也不依赖某个本机技能是否安装。
- `docs/` 的现有资料不得因整理被擅自删除，历史票也一样；删除或取消跟踪都必须先获得用户确认。用户要求只取消跟踪时保留本地文件。
- 根 `docs/` 由 `.gitignore` 精确选择公开资料，新增本地票默认不公开；需要公开时明确调整白名单。正式场景文档放 `src/scenes/<scene>/docs/`。
