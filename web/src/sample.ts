/** Payloads that resemble what an LLM client actually shuffles around. */

export type SampleId = "prompt" | "tool" | "tokens" | "sse";

export const SAMPLES: { id: SampleId; label: string; hint: string }[] = [
  { id: "prompt", label: "对话", hint: "一段带来源的用户消息" },
  { id: "tool", label: "工具参数", hint: "模型发给工具的 JSON" },
  { id: "tokens", label: "token 流", hint: "一串整型 token id" },
  { id: "sse", label: "SSE 帧", hint: "流式补全的一帧" },
];

const PROMPT = {
  role: "user",
  content: [
    {
      type: "text",
      text: "把下面这段会议记录整理成决定、负责人和截止日期。不要复述原文。",
    },
    {
      type: "text",
      text: "周一站会：接口延迟从 180ms 涨到 640ms，怀疑是 JSON 反复解析。Ada 周三前给出编解码基准，Ben 负责把静态页挂到 Pages，不新开源站。",
    },
  ],
};

const TOOL = {
  name: "lookup_trace",
  arguments: {
    service: "gateway",
    window: { from: "2026-10-27T02:10:00Z", to: "2026-10-27T02:40:00Z" },
    filters: ["codec=json", "status>=500"],
    limit: 40,
  },
};

const SSE =
  'data: {"id":"chatcmpl_7f3a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"编解码发生在浏览器里，"},"finish_reason":null}]}\n\n';

const MAX_SAMPLE = 1024 * 1024;

export function sampleBytes(id: SampleId, repeats: number): Uint8Array {
  const piece = new TextEncoder().encode(unitOf(id));
  const n = Math.max(1, Math.min(repeats, 20_000));
  const count = Math.min(n, Math.max(1, Math.floor(MAX_SAMPLE / piece.length)));
  const out = new Uint8Array(piece.length * count);
  for (let i = 0; i < count; i++) out.set(piece, i * piece.length);
  return out;
}

function unitOf(id: SampleId): string {
  switch (id) {
    case "prompt":
      return JSON.stringify(PROMPT);
    case "tool":
      return JSON.stringify(TOOL);
    case "tokens":
      return tokenRun();
    case "sse":
      return SSE;
  }
}

function tokenRun(): string {
  const ids: number[] = [];
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    ids.push((x >>> 0) % 128_000);
  }
  return ids.join(",");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRate(mib: number): string {
  if (!Number.isFinite(mib) || mib <= 0) return "—";
  if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GiB/s`;
  if (mib >= 10) return `${mib.toFixed(1)} MiB/s`;
  return `${mib.toFixed(2)} MiB/s`;
}

export function formatOps(ops: number): string {
  if (!Number.isFinite(ops) || ops <= 0) return "—";
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)} M/s`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)} k/s`;
  return `${ops.toFixed(0)} /s`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}
