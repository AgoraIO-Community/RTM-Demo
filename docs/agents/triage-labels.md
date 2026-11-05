# Triage 标签

分诊用于决定任务下一步交给谁，与执行状态分开记录。这里沿用五个规范标签，Codex 和其他按项目指令工作的工具使用同一套名称，不依赖 Claude。

| 分诊角色 | 标签字符串 | 含义 |
| --- | --- | --- |
| 待评估 | `needs-triage` | 需要维护者评估范围、价值和处理方式 |
| 待补充 | `needs-info` | 缺少复现步骤、需求或其他必要信息 |
| 可交给 Agent | `ready-for-agent` | 信息与边界明确，可交给 Agent 执行 |
| 需要人工 | `ready-for-human` | 必须由人工处理或决策 |
| 不予处理 | `wontfix` | 明确决定不实施，并记录原因 |

标签写在本地 issue 顶部的 `Triage:` 行，取值为表格第二列的字面量。例如：

```text
Status: open
Triage: ready-for-agent
```

`Status:` 只记录 `open` / `claimed` / `resolved` 的执行状态，不再混用分诊标签。详细流程与历史票兼容方式见 [issue-tracker.md](./issue-tracker.md)。以后若调整标签名称，同步修改本表与依赖它的工作流说明。
