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

/** Which optional body parameters this attempt may send. */
export type PayloadOptions = {
  temperature: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
};

const BASE_OPTIONS: PayloadOptions = { temperature: true, maxTokensField: "max_tokens" };

export type ProbeResult = { report: Report; text: string; adaptations: string[] };

const encoder = new TextEncoder();

export async function probeOnce(kernel: Kernel, req: ProbeRequest, signal: AbortSignal): Promise<ProbeResult> {
  const url = requestUrl(req.api, req.endpoint);
  mixedContentWarning(url);
  // Production always talks directly to the URL in the form. In particular,
  // 127.0.0.1 means the visitor's computer, not the Cloudflare machine.
  // The Vite relay exists only to make local development convenient.
  const relay = import.meta.env.DEV && isLocalUrl(url);
  const headers = requestHeaders(req);
  const adaptations: string[] = [];
  let options = { ...BASE_OPTIONS };

  for (let attempt = 0; ; attempt++) {
    const payload = JSON.stringify(requestBody(req, options));
    const started = performance.now();
    req.onPhase?.("sent");
    let response: Response;
    try {
      req.onPhase?.("waiting");
      response = await fetch(relay ? "/probe" : url, {
        method: "POST",
        headers: relay ? { "content-type": "application/json" } : headers,
        body: relay ? JSON.stringify({ url, headers, body: payload }) : payload,
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new Error("已取消");
      const message = err instanceof Error ? err.message : "请求失败";
      throw new Error(corsHint(message));
    }

    // Newer OpenAI models reject `max_tokens` and reasoning models reject
    // `temperature`. Retry once with the shape the endpoint asked for.
    if (response.status === 400 && attempt < 2) {
      const detail = await response.text().catch(() => "");
      const retry = adaptPayload(options, detail, req.api);
      if (retry) {
        options = retry.options;
        adaptations.push(retry.note);
        continue;
      }
      throw new Error(httpError(400, detail));
    }

    const ttfb = performance.now() - started;
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(httpError(response.status, detail));
    }

    const ticks: Tick[] = [];
    let text = "";
    let received = 0;
    let carry = new Uint8Array(0);
    let lastMs = 0;
    let sawContent = false;
    const absorb = (events: StreamEvent[], from: number, span: number) => {
      const now = performance.now() - started;
      for (const event of events) {
        // `at` is the byte offset where the event starts. Interpolating by it
        // gives each delta in a multiplexed chunk its own timestamp, so a
        // burst of frames no longer collapses into one instant.
        const fraction = span > 0 ? Math.min(1, Math.max(0, (event.at - from) / span)) : 1;
        lastMs = lastMs + (now - lastMs) * fraction;
        if (event.kind === "content" && event.text) {
          text += event.text;
          if (!sawContent) {
            sawContent = true;
            req.onPhase?.("streaming");
          }
        }
        ticks.push({
          tMs: lastMs,
          kind: event.kind,
          text: event.text,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          finishReason: event.finishReason,
        });
      }
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const from = received;
        received += value.byteLength;
        const fed = kernel.feed(carry, value, received);
        carry = fed.carry;
        absorb(fed.events, from, value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
    absorb(kernel.finish(carry, received), received - carry.byteLength, carry.byteLength);

    req.onPhase?.("done");
    const total = performance.now() - started;
    const report = kernel.summarize({
      tHeadersMs: ttfb,
      tTotalMs: total,
      requestBytes: encoder.encode(payload).byteLength,
      responseBytes: received,
      ticks,
    });
    return { report, text, adaptations };
  }
}

/**
 * Read a 400 body and decide which parameter the endpoint refused.
 * Only called for the first two attempts.
 */
export function adaptPayload(
  options: PayloadOptions,
  detail: string,
  api: ApiKind,
): { options: PayloadOptions; note: string } | null {
  const text = detail.toLowerCase();
  const unsupported = /(unsupported|not supported|not allowed|does not support|unrecognized|unknown parameter|不支持|未知参数)/.test(
    text,
  );
  if (options.temperature && text.includes("temperature") && unsupported) {
    return {
      options: { ...options, temperature: false },
      note: "这个模型不接受 temperature，已自动省去。",
    };
  }
  if (api === "chat" && options.maxTokensField === "max_tokens" && text.includes("max_completion_tokens")) {
    return {
      options: { ...options, maxTokensField: "max_completion_tokens" },
      note: "接口要求 max_completion_tokens，已自动改写。",
    };
  }
  if (api === "chat" && options.maxTokensField === "max_completion_tokens" && text.includes("max_tokens") && unsupported) {
    return {
      options: { ...options, maxTokensField: "max_tokens" },
      note: "接口只接受 max_tokens，已自动改回。",
    };
  }
  return null;
}

const SUFFIX: Record<ApiKind, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  anthropic: "/messages",
};

export function requestUrl(api: ApiKind, endpoint: string): string {
  const url = absoluteUrl(endpoint);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const complete = Object.values(SUFFIX).some((suffix) => path.endsWith(suffix));
  if (!complete) {
    url.pathname = `${path === "/" ? "" : path}${SUFFIX[api]}`;
  }
  return url.toString();
}

export function requestBody(req: ProbeRequest, options: PayloadOptions = BASE_OPTIONS): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
  };
  if (options.temperature) body.temperature = req.temperature;

  if (req.api === "chat") {
    return {
      ...body,
      messages: [{ role: "user", content: req.prompt }],
      stream_options: { include_usage: true },
      [options.maxTokensField]: req.maxTokens,
    };
  }
  if (req.api === "responses") {
    return {
      ...body,
      input: req.prompt,
      max_output_tokens: req.maxTokens,
    };
  }
  return {
    ...body,
    messages: [{ role: "user", content: req.prompt }],
    max_tokens: req.maxTokens,
  };
}

function mixedContentWarning(value: string) {
  if (!import.meta.env.PROD || window.location.protocol !== "https:") return;
  const url = new URL(value);
  if (url.protocol === "http:" && isLocalUrl(value)) {
    throw new Error("当前页面是 HTTPS，浏览器会拦截它访问 HTTP 本地网关。请给网关启用 HTTPS，或在本地用 npm run dev 测。");
  }
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
  const relay = import.meta.env.DEV && isLocalUrl(url);
  const response = await fetch(relay ? "/probe" : url, {
    method: relay ? "POST" : "GET",
    headers: relay ? { "content-type": "application/json" } : headers,
    body: relay ? JSON.stringify({ url, method: "GET", headers }) : undefined,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(httpError(response.status, detail));
  }
  const payload: unknown = await response.json();
  return modelIds(payload);
}

export function modelIds(payload: unknown): string[] {
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

export function httpError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, " ").slice(0, 180);
  if (status === 401 || status === 403) return `密钥被拒绝（${status}）${snippet ? `：${snippet}` : ""}`;
  if (status === 404) return "这个地址返回 404。请填完整路径，不要只填到 /v1";
  return `接口返回 ${status}${snippet ? `：${snippet}` : ""}`;
}

function corsHint(message: string): string {
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "浏览器直接请求本地网关失败了。请确认网关已启用 CORS，允许当前页面跨域访问；请求不会经过 Cloudflare。";
  }
  return message;
}
