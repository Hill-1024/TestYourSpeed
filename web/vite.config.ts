import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only relay. The page calls the same origin at `/probe`; Vite forwards
// that to the URL the user typed. A local gateway such as 127.0.0.1:3425
// does not send CORS headers, so the browser cannot call it directly.
function probeRelay(): Plugin {
  return {
    name: "probe-relay",
    configureServer(server) {
      server.middlewares.use("/probe", (req, res) => {
        void relay(req, res);
      });
    },
  };
}

async function relay(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405).end("只接受 POST");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let parsed: { url?: string; method?: string; headers?: Record<string, string>; body?: string };
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof parsed;
  } catch {
    res.writeHead(400).end("请求不是 JSON");
    return;
  }
  let target: URL;
  try {
    target = new URL(parsed.url ?? "");
  } catch {
    res.writeHead(400).end("目标地址无效");
    return;
  }
  // The relay itself only listens on 127.0.0.1, so widening the target does
  // not expose it. It also rescues endpoints that never answer preflight.
  if (!["http:", "https:"].includes(target.protocol)) {
    res.writeHead(403).end("只支持 http 或 https 目标");
    return;
  }
  const method = parsed.method === "GET" ? "GET" : "POST";
  const headers = new Headers();
  for (const [name, value] of Object.entries(parsed.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  if (method === "POST" && !headers.has("content-type")) headers.set("content-type", "application/json");
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" ? undefined : parsed.body ?? "",
    });
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "转发失败";
    if (!res.headersSent) res.writeHead(502);
    res.end(message);
  }
}

function isLocal(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

void (0 as unknown as ViteDevServer);

export default defineConfig({
  plugins: [react(), probeRelay()],
  base: "/",
  server: { host: "127.0.0.1", port: 5173 },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
