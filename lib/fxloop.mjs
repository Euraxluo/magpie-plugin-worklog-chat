// 底层聊天循环：fx（Vercel 原生 coding agent，模型走 magpie 路由可随时切）。
// 驱动方式：spawn `fx ask --json --resume-id <id>`，每轮一个进程，靠 fx 自己的
// session 存储（~/.fx/sessions/v2/<id>/log.jsonl）保持多轮记忆。
// 可移植历史：每轮结束把 user/assistant 追加进插件自己的 threads/<id>/thread.jsonl
// ——与引擎无关的纯 JSONL，换任何 coding agent 都能导入。
import { spawn } from "node:child_process";
import { mkdir, readFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FX = path.join(os.homedir(), ".local/bin/fx");
const STORE = path.join(os.homedir(), ".config/magpie-plugin-worklog-chat/threads");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runAsk({ prompt, sessionId, model, effort, timeoutMs = 300000 }) {
  const args = ["ask", "--json", "--no-color"];
  if (sessionId) args.push("--resume-id", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  args.push("--", prompt);
  return new Promise((resolve) => {
    const p = spawn(FX, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve({ ok: false, error: "超时（5 分钟）" }); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      clearTimeout(t);
      // --json 输出是流式 JSON 行，取最后一条完整对象
      let last = null;
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try { last = JSON.parse(s); } catch { }
      }
      if (!last) return resolve({ ok: false, error: (err || out).slice(0, 400) || "无输出" });
      resolve({
        ok: last.exit_code === 0,
        text: last.final_output || last.output || "",
        sessionId: last.session_id,
        model: last.model,
        usage: last.usage,
        toolCalls: (last.tool_calls || []).length,
      });
    });
  });
}

async function threadDir(id) {
  const d = path.join(STORE, id);
  await mkdir(d, { recursive: true });
  return d;
}

export async function listThreads() {
  if (!existsSync(STORE)) return [];
  const out = [];
  for (const id of await readdir(STORE)) {
    const meta = path.join(STORE, id, "meta.json");
    try { out.push({ id, ...JSON.parse(await readFile(meta, "utf8")) }); } catch { out.push({ id, title: id }); }
  }
  out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return out;
}

export async function threadMessages(id) {
  try {
    const f = path.join(STORE, id, "thread.jsonl");
    const text = await readFile(f, "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function appendEvent(id, ev) {
  const d = await threadDir(id);
  await appendFile(path.join(d, "thread.jsonl"), JSON.stringify(ev) + "\n");
}

async function saveMeta(id, patch) {
  const d = await threadDir(id);
  const metaF = path.join(d, "meta.json");
  let meta = {};
  try { meta = JSON.parse(await readFile(metaF, "utf8")); } catch { }
  Object.assign(meta, patch, { updated: Date.now() });
  await appendFile(metaF, ""); // touch
  const { writeFile } = await import("node:fs/promises");
  await writeFile(metaF, JSON.stringify(meta, null, 2));
  return meta;
}

export async function chat({ threadId, prompt, model, effort }) {
  // fx 默认 auto-auto 会注入全部 skills（~30k tokens）且排队慢；显式快模型 5s 级
  model = model || "group/glm-5.3";
  // 1) fx 跑这一轮（resume 上一轮的 fx session 保持工具记忆）
  const prev = threadId ? await lastFxSession(threadId) : null;
  const r = await runAsk({ prompt, sessionId: prev, model, effort });
  if (!r.ok) return r;

  // 2) 可移植历史落盘（引擎无关）
  let id = threadId;
  if (!id) id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await appendEvent(id, { t: Date.now(), role: "user", text: prompt });
  await appendEvent(id, { t: Date.now(), role: "assistant", text: r.text, model: r.model, engine: "fx" });
  const title = (await saveMeta(id, { fxSession: r.sessionId, engine: "fx" })).title || prompt.slice(0, 24);
  await saveMeta(id, { title });
  return { ok: true, threadId: id, text: r.text, model: r.model, toolCalls: r.toolCalls, usage: r.usage };
}

async function lastFxSession(threadId) {
  try {
    const meta = JSON.parse(await readFile(path.join(STORE, threadId, "meta.json"), "utf8"));
    return meta.fxSession || null;
  } catch { return null; }
}

// 把外部会话（如 codex://threads/<uuid>）导入为可移植历史
export async function importExternal({ source, title, messages }) {
  const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  for (const m of messages) {
    await appendEvent(id, { t: m.t || Date.now(), role: m.role, text: m.text, engine: source });
  }
  await saveMeta(id, { title: title || source, engine: source, imported: true });
  return { ok: true, threadId: id, count: messages.length };
}

export async function deleteThread(id) {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(STORE, id), { recursive: true, force: true });
  return { ok: true };
}

// 导出为通用 markdown（给任何 agent / 人看）
export async function exportMarkdown(id) {
  const msgs = await threadMessages(id);
  const lines = [`# ${id}`, ""];
  for (const m of msgs) {
    lines.push(`**${m.role}**${m.model ? ` (${m.model})` : ""} · ${new Date(m.t).toLocaleString("zh-CN")}`, "", m.text, "");
  }
  return lines.join("\n");
}
