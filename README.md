# magpie-plugin-worklog-chat · 周报工坊

magpie 窗口里的对话式周报工作台（fork magpie-chat 的页面模式）。

- **底层聊天循环：fx**（Vercel 原生 coding agent）——模型经 magpie 网关路由，界面上随时切
- **对话历史 = 可移植资产**：每轮落 `~/.config/magpie-plugin-worklog-chat/threads/<id>/thread.jsonl`（引擎无关 JSONL），一键导出 Markdown；codex/claude 等外部会话可导入——换 coding agent 历史随身走
- **magpie 会话搜索 tool**：右侧抽屉按关键词/agent 捞本机全部 coding agent 的历史会话（claude/codex/omp/opencode/cursor/…），命中片段一键喂进对话，与 weekly-reporting-system、performance-assessment 等 skill 协同

## 使用

需本机有 `fx`（`~/.local/bin/fx`，provider 指向 magpie）和 sibling 插件 magpie-plugin-worklog（会话搜索数据层）。
