import type { Kernel, Report, StreamEvent, Tick } from "./kernel";

export type ApiKind = "chat" | "responses" | "anthropic";

export type ProbePhase = "sent" | "waiting" | "streaming" | "done";

export type ProbeRequest = {
  api: ApiKind;
  endpoint: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  onPhase?: (phase: ProbePhase) => void;
};

const encoder = new TextEncoder();

export async function probeOnce(kernel: Kernel, req: ProbeRequest, signal: AbortSignal): Promise<{ report: Report; text: string }> {
  const url = requestUrl(req.api, req.endpoint);
  const payload = JSON.stringify(requestBody(req));
  const headers = requestHeaders(req);
  const local = isLocalUrl(url);

  const started = performance.now();
  req.onPhase?.("sent");
  let response: Response;
  try {
    req.onPhase?.("waiting");
    response = await fetch(local ? "/probe" : url, {
      method: "POST",
      headers: local ? { "content-type": "application/json" } : headers,
      body: local ? JSON.stringify({ url, headers, body: payload }) : payload,
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new Error("已取消");
    const message = err instanceof Error ? err.message : "请求失败";
    throw new Error(corsHint(message));
  }

  const ttfb = performance.now() - started;
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(httpError(response.status, detail));
  }

  req.onPhase?.("streaming");
  const ticks: Tick[] = [];
  let text = "";
  let received = 0;
  let carry = new Uint8Array(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const fed = kernel.feed(carry, value, received);
      carry = fed.carry;
      absorb(fed.events, started, ticks, (piece) => {
        text += piece;
      });
    }
  } finally {
    reader.releaseLock();
  }
  const tail = kernel.finish(carry, received);
  absorb(tail, started, ticks, (piece) => {
    text += piece;
  });

  req.onPhase?.("done");
  const total = performance.now() - started;
  const report = kernel.summarize({
    tHeadersMs: ttfb,
    tTotalMs: total,
    requestBytes: encoder.encode(payload).byteLength,
    responseBytes: received,
    ticks,
  });
  return { report, text };
}

function absorb(events: StreamEvent[], started: number, ticks: Tick[], onText: (piece: string) => void) {
  const now = performance.now() - started;
  for (const event of events) {
    if (event.kind === "content" && event.text) onText(event.text);
    ticks.push({
      tMs: now,
      kind: event.kind,
      text: event.text,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      finishReason: event.finishReason,
    });
  }
}

const SUFFIX: Record<ApiKind, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  anthropic: "/messages",
};

function requestUrl(api: ApiKind, endpoint: string): string {
  const url = absoluteUrl(endpoint);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const complete = Object.values(SUFFIX).some((suffix) => path.endsWith(suffix));
  if (!complete) {
    url.pathname = `${path === "/" ? "" : path}${SUFFIX[api]}`;
  }
  return url.toString();
}

function requestBody(req: ProbeRequest): Record<string, unknown> {
  if (req.api === "chat") {
    return {
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
  }
  if (req.api === "responses") {
    return {
      model: req.model,
      input: req.prompt,
      stream: true,
      max_output_tokens: req.maxTokens,
      temperature: req.temperature,
    };
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stream: true,
    messages: [{ role: "user", content: req.prompt }],
  };
}

function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function modelsUrl(endpoint: string, override: string): string {
  const custom = override.trim();
  if (custom) return absoluteUrl(custom).toString();
  const base = absoluteUrl(endpoint);
  const path = base.pathname.replace(/\/+$/, "") || "/";
  const complete = Object.values(SUFFIX).some((suffix) => path.endsWith(suffix));
  base.pathname = complete ? "/models" : `${path === "/" ? "" : path}/models`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export async function listModels(endpoint: string, override: string, apiKey: string, api: ApiKind, signal: AbortSignal): Promise<string[]> {
  const url = modelsUrl(endpoint, override);
  const headers = authHeaders(api, apiKey);
  const local = isLocalUrl(url);
  const response = await fetch(local ? "/probe" : url, {
    method: local ? "POST" : "GET",
    headers: local ? { "content-type": "application/json" } : headers,
    body: local ? JSON.stringify({ url, method: "GET", headers }) : undefined,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(httpError(response.status, detail));
  }
  const payload: unknown = await response.json();
  return modelIds(payload);
}

function modelIds(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const ids = rows
    .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : row))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  return [...new Set(ids)];
}

function authHeaders(api: ApiKind, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = apiKey.trim();
  if (!key) return headers;
  if (api === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function absoluteUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("先填写接口地址");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("地址不是完整的 URL，需要带 https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("地址只支持 http 或 https");
  }
  return url;
}

function requestHeaders(req: ProbeRequest): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = req.apiKey.trim();
  if (!key) return headers;
  if (req.api === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function httpError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, " ").slice(0, 180);
  if (status === 401 || status === 403) return `密钥被拒绝（${status}）${snippet ? `：${snippet}` : ""}`;
  if (status === 404) return "这个地址返回 404。请填完整路径，不要只填到 /v1";
  return `接口返回 ${status}${snippet ? `：${snippet}` : ""}`;
}

function corsHint(message: string): string {
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "浏览器没有连上接口。本机地址请用 npm run dev 打开页面；线上页面只能请求允许跨域的接口。";
  }
  return message;
}
