// SSE 小工具（server.mjs 与 fxengine.mjs 共用）
export function sseHead(res, cors = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...cors,
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
}

export function sse(res, type, data) {
  if (res.writableEnded) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
