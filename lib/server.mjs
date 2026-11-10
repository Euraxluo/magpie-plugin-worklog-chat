// HTTP 服务（127.0.0.1:3493）：聊天 UI + REST API。安全模型同 baohe 插件 v0.3：
// 本机自用，无 token；仅留 Host 白名单（防 DNS rebinding）+ Origin 白名单（防跨站）。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchSessions, ensureServer } from "../../magpie-plugin-worklog/lib/collector.mjs";
import * as fxloop from "./fxloop.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3493;

const HOSTS = new Set(["127.0.0.1:3493", "localhost:3493"]);
const ORIGINS = new Set(["null", "http://127.0.0.1:3493", "http://localhost:3493"]);

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
function hostOK(req) { return HOSTS.has((req.headers.host || "").toLowerCase()); }
function originOK(req) {
  const o = req.headers.origin;
  return !o || ORIGINS.has(o.toLowerCase());
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...cors() });
  res.end(body);
}

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  try { return JSON.parse(b || "{}"); } catch { return {}; }
}

let appHtml = null;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (!hostOK(req)) return send(res, 403, { error: "bad host" });
  if (p === "/" || p === "/index.html") {
    if (!appHtml) appHtml = await readFile(join(here, "app.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors() });
    return res.end(appHtml);
  }
  if (!originOK(req)) return send(res, 403, { error: "bad origin" });
  if (req.method === "OPTIONS") { res.writeHead(204, cors()); return res.end(); }

  if (req.method === "GET" && p === "/api/threads") return send(res, 200, { threads: await fxloop.listThreads() });
  if (req.method === "GET" && p === "/api/thread") {
    const id = u.searchParams.get("id");
    return send(res, 200, { messages: await fxloop.threadMessages(id) });
  }
  if (req.method === "GET" && p === "/api/export") {
    return send(res, 200, { markdown: await fxloop.exportMarkdown(u.searchParams.get("id")) });
  }
  if (req.method === "POST" && p === "/api/chat") {
    const b = await readBody(req);
    const r = await fxloop.chat({ threadId: b.threadId, prompt: b.prompt, model: b.model, effort: b.effort });
    return send(res, 200, r);
  }
  if (req.method === "POST" && p === "/api/import") {
    const b = await readBody(req);
    if (b.preset === "codex-baohe") {
      const { messages } = await import("./import-codex-baohe.mjs");
      const r = await fxloop.importExternal({ source: "codex://threads/019fe0a8-b4eb-7d50-b62d-3f73f108ed68", title: "周报方法论（codex 原始对话）", messages });
      return send(res, 200, r);
    }
    return send(res, 400, { error: "unknown preset" });
  }
  if (req.method === "DELETE" && p === "/api/thread") {
    return send(res, 200, await fxloop.deleteThread(u.searchParams.get("id")));
  }

  // magpie 会话搜索 tool：给周报/绩效 skill 的取数通道
  if (req.method === "GET" && p === "/api/sessions") {
    await ensureServer();
    const q = u.searchParams;
    const r = await searchSessions({
      q: q.get("q") || "",
      agents: q.get("agents")?.split(",").filter(Boolean),
      limit: Math.min(Number(q.get("limit")) || 50, 200),
    });
    return send(res, 200, r);
  }

  // fx 可用模型（走 magpie 网关）
  if (req.method === "GET" && p === "/api/models") {
    try {
      const r = await fetch("http://127.0.0.1:3425/v1/models", { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      const ids = (d.data || []).map((m) => m.id).filter((x) => !/embed|whisper|tts|image|video/i.test(x));
      return send(res, 200, { models: ids.slice(0, 120) });
    } catch (e) { return send(res, 200, { models: [], error: String(e?.message || e) }); }
  }

  return send(res, 404, { error: "no route " + p });
});

export function startServer() {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[magpie-plugin-worklog-chat] listening on http://127.0.0.1:${PORT}`);
  });
  return server;
}
startServer();
