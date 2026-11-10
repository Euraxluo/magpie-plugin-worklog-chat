// fx 引擎：把 magpie-chat 的「对话执行器」换成 fx（coding agent）。
// 对前端协议零改动：SSE 事件序列 start → (reasoning) → delta → (tool) → done，
// conversations 存储照旧由 UI 侧维护；这里额外把每轮写进引擎无关的可移植历史
// ~/.config/magpie-plugin-worklog-chat-v2/threads/<conversationId>/thread.jsonl，
// fxSession 映射存在旁边 meta.json —— 换模型、换 coding agent 都能带走。
import { spawn } from "node:child_process";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sse } from "./server-sse.mjs"; // 共用 SSE（server.mjs 同源）

const FX = path.join(os.homedir(), ".local/bin/fx");
const STORE = path.join(os.homedir(), ".config/magpie-plugin-worklog-chat-v2/threads");
const DEFAULT_MODEL = "group/glm-5.3"; // fx 默认 auto 会注入全部 skills（~30k tok）且排队慢

function runAsk({ prompt, sessionId, model, effort, onTool, timeoutMs = 600000 }) {
  const args = ["ask", "--json", "--no-color"];
  if (sessionId) args.push("--resume-id", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  args.push("--", prompt);
  return new Promise((resolve) => {
    const p = spawn(FX, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => {
      out += d;
      // 流式 JSON 行里 tool 事件即时上报（不落盘解析，只透传给 SSE）
      for (const line of String(d).split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try {
          const j = JSON.parse(s);
          if (j.type === "tool_call" && onTool) onTool(j);
        } catch { /* 不完整行等 close 时兜底 */ }
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      clearTimeout(kill);
      let last = null;
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try { last = JSON.parse(s); } catch { }
      }
      if (!last) return resolve({ ok: false, error: (err || out).slice(0, 400) || "fx 无输出" });
      resolve({
        ok: last.exit_code === 0,
        text: last.final_output || last.output || "",
        sessionId: last.session_id,
        model: last.model,
        usage: last.usage,
        toolCalls: last.tool_calls || [],
      });
    });
  });
}

async function threadsDir(id) {
  const d = path.join(STORE, id);
  await mkdir(d, { recursive: true });
  return d;
}

async function readMeta(id) {
  try { return JSON.parse(await readFile(path.join(STORE, id, "meta.json"), "utf8")); } catch { return {}; }
}
async function writeMeta(id, patch) {
  const d = await threadsDir(id);
  const meta = { ...(await readMeta(id)), ...patch, updated: Date.now() };
  await writeFile(path.join(d, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function runFxChat({ res, body, settings, store, options }, controllers) {
  const clientId = String(body.clientId || "");
  const abort = new AbortController();
  if (clientId) controllers.set(clientId, abort);
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const started = Date.now();
  const model = String(body.model || settings.model || DEFAULT_MODEL);
  const effort = String(body.effort ?? settings.effort ?? "");
  const history = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant")) : [];
  const convId = String(body.conversationId || "adhoc");
  const prompt = String(history[history.length - 1]?.content ?? "").trim();
  if (!prompt) { sse(res, "error", { message: "没有内容可发送" }); res.end(); return; }
  if (!existsSync(FX)) { sse(res, "error", { message: "未找到 fx（~/.local/bin/fx）" }); res.end(); return; }

  // fx 的多轮记忆走自己的 session（meta.fxSession）；本轮上下文补一段可移植历史摘要
  const meta = await readMeta(convId);
  const resumeId = meta.fxSession || null;
  sse(res, "start", { model, engine: "fx", tools: [], resumed: Boolean(resumeId) });

  const r = await runAsk({
    prompt, sessionId: resumeId, model, effort,
    onTool: (t) => sse(res, "tool", { phase: "call", id: t.id || "", name: t.name || "fx-tool", args: t.args || {}, result: "", fx: true }),
  });
  if (abort.signal.aborted) return;

  if (!r.ok) {
    sse(res, "error", { message: "fx: " + (r.error || "失败") });
    res.end();
    return;
  }

  sse(res, "delta", { text: r.text });
  // 可移植历史落盘（user 这轮 + assistant 这轮，含模型/引擎标记）
  const d = await threadsDir(convId);
  await appendFile(path.join(d, "thread.jsonl"), JSON.stringify({ t: Date.now(), role: "user", text: prompt }) + "\n");
  await appendFile(path.join(d, "thread.jsonl"), JSON.stringify({ t: Date.now(), role: "assistant", text: r.text, model: r.model, engine: "fx", tools: r.toolCalls.length }) + "\n");
  await writeMeta(convId, { fxSession: r.sessionId, engine: "fx", lastModel: r.model });
  if (r.toolCalls.length) sse(res, "tool", { phase: "result", id: "fx", name: "fx", args: {}, result: `${r.toolCalls.length} 次工具调用（fx 内部执行）`, isError: false });

  sse(res, "done", { ms: Date.now() - started, usage: r.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, engine: "fx" });
  res.end();
}

// 导入外部对话（codex/claude/…）为可移植历史
export async function importThread({ conversationId, source, title, messages }) {
  const id = conversationId || "imp" + Date.now().toString(36);
  const d = await threadsDir(id);
  for (const m of messages) {
    await appendFile(path.join(d, "thread.jsonl"), JSON.stringify({ t: m.t || Date.now(), role: m.role, text: m.text, engine: source }) + "\n");
  }
  await writeMeta(id, { title: title || source, engine: source, imported: true });
  return { ok: true, id, count: messages.length };
}

export async function exportThreadMarkdown(id) {
  try {
    const lines = (await readFile(path.join(STORE, id, "thread.jsonl"), "utf8")).split("\n").filter(Boolean);
    const out = [`# ${id}`, ""];
    for (const l of lines) {
      const m = JSON.parse(l);
      out.push(`**${m.role}**${m.model ? ` (${m.model})` : ""}${m.engine ? ` · ${m.engine}` : ""} · ${new Date(m.t).toLocaleString("zh-CN")}`, "", m.text, "");
    }
    return out.join("\n");
  } catch { return `（${id} 没有可移植历史）`; }
}
