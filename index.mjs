// @euraxluo/magpie-plugin-worklog-chat：magpie 窗口里的「周报工坊」对话页。
//
// 1. 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载。
// 2. 加载即起本地 HTTP 服务（127.0.0.1:3493）：聊天 UI + REST API。
// 3. 底层聊天循环 = fx（spawn `fx ask --json --resume-id`，多轮靠 fx session 记忆，
//    模型经 magpie 网关随时切）。
// 4. 对话历史同时落进插件自己的 ~/.config/magpie-plugin-worklog-chat/threads/<id>/thread.jsonl
//    ——引擎无关的可移植 JSONL，换任何 coding agent 都能带走。
import { startServer } from "./lib/server.mjs";

startServer();
