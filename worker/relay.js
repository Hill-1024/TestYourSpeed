/**
 * Stateless relay for endpoints that do not answer CORS preflight.
 *
 * The page posts { url, method, headers, body } here, the Worker forwards it
 * and streams the response back. Nothing is stored, logged, or queued.
 * Loopback and private addresses are refused so this cannot be used to probe
 * the Worker's own network.
 */

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "HEAD"]);
const SKIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);

export function blockedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return true;
  if (["localhost", "metadata", "metadata.google.internal", "instance-data"].includes(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;
  if (/^(0|10|127)\./.test(host)) return true;
  if (/^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fe80") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    );
  }
  return false;
}

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", "x-relay-error": "1" },
  });
}

async function relay(request) {
  if (request.method !== "POST") return fail(405, "只接受 POST");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail(413, "请求太大");

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return fail(403, "只允许本站页面使用");

  let parsed;
  try {
    parsed = await request.json();
  } catch {
    return fail(400, "请求不是 JSON");
  }
  if (!parsed || typeof parsed.url !== "string") return fail(400, "缺少 url");

  let target;
  try {
    target = new URL(parsed.url);
  } catch {
    return fail(400, "目标地址无效");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return fail(400, "只支持 http 或 https");
  if (blockedHost(target.hostname)) return fail(403, "不转发内网地址");

  const method = ALLOWED_METHODS.has(parsed.method) ? parsed.method : "POST";
  const headers = new Headers();
  for (const [name, value] of Object.entries(parsed.headers ?? {})) {
    if (typeof value === "string" && !SKIPPED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (method === "POST" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const body = method === "GET" || method === "HEAD" ? undefined : String(parsed.body ?? "");

  let upstream;
  try {
    upstream = await fetch(target, { method, headers, body, redirect: "manual" });
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : "上游请求失败");
  }

  const out = new Headers();
  const type = upstream.headers.get("content-type");
  if (type) out.set("content-type", type);
  const location = upstream.headers.get("location");
  if (location) out.set("location", location);
  out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/relay") return relay(request);
    return env.ASSETS.fetch(request);
  },
};
