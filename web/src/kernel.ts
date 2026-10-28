/**
 * Loader for the C-ABI kernel. Each call copies its bytes in and the result
 * out. The unfinished SSE tail is returned to the page; the module does not
 * keep a run.
 */

import wasmUrl from "./wasm/io_kernel.wasm?url";

export type StreamEvent = {
  at: number;
  kind: string;
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
};

export type Tick = {
  tMs: number;
  kind: string;
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
};

export type Report = {
  ok: boolean;
  error: string | null;
  warning: string | null;
  ttftMs: number | null;
  totalMs: number;
  ttfbMs: number;
  tLastMs: number | null;
  tokensPerSec: number | null;
  e2eTokensPerSec: number | null;
  itlMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimated: boolean;
  truncated: boolean;
  windowShort: boolean;
  requestBytes: number;
  responseBytes: number;
  chars: number;
};

export type Summary = {
  ok: boolean;
  error: string | null;
  ttftMs: number | null;
  totalMs: number | null;
  ttfbMs: number | null;
  tokensPerSec: number | null;
  e2eTokensPerSec: number | null;
  itlMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimated: boolean;
  truncated: boolean;
  windowShort: boolean;
  requestBytes: number;
  responseBytes: number;
  chars: number;
  warning: string | null;
  runs: Report[];
};

export type CardInput = {
  model: string;
  protocol: string;
  runs: number;
  date: string;
  ttftMs: number | null;
  totalMs: number | null;
  tokensPerSec: number | null;
  e2eTokensPerSec: number | null;
  itlMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  chars: number;
  estimated: boolean;
  truncated: boolean;
  windowShort: boolean;
};

type FeedJson = { carryB64: string; events: StreamEvent[] };
type CardJson = { svg: string };

type Exports = {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  last_error: (outPtr: number, outCap: number) => number;
  feed: (
    carryPtr: number,
    carryLen: number,
    chunkPtr: number,
    chunkLen: number,
    chunkOffset: number,
    outPtr: number,
    outCap: number,
  ) => number;
  finish: (
    carryPtr: number,
    carryLen: number,
    carryOffset: number,
    outPtr: number,
    outCap: number,
  ) => number;
  parse_unary: (bodyPtr: number, bodyLen: number, outPtr: number, outCap: number) => number;
  summarize: (specPtr: number, specLen: number, outPtr: number, outCap: number) => number;
  aggregate: (runsPtr: number, runsLen: number, outPtr: number, outCap: number) => number;
  render_card: (inputPtr: number, inputLen: number, outPtr: number, outCap: number) => number;
};

export type Kernel = {
  feed: (
    carry: Uint8Array<ArrayBuffer>,
    chunk: Uint8Array<ArrayBuffer>,
    chunkOffset: number,
  ) => { carry: Uint8Array<ArrayBuffer>; events: StreamEvent[] };
  finish: (carry: Uint8Array, carryOffset: number) => StreamEvent[];
  parseUnary: (body: Uint8Array) => StreamEvent[];
  summarize: (spec: {
    tHeadersMs: number;
    tTotalMs: number;
    requestBytes: number;
    responseBytes: number;
    ticks: Tick[];
  }) => Report;
  aggregate: (runs: Report[]) => Summary;
  renderCard: (input: CardInput) => string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let pending: Promise<Kernel> | null = null;

export function loadKernel(): Promise<Kernel> {
  pending ??= instantiate();
  return pending;
}

async function instantiate(): Promise<Kernel> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`测速内核加载失败 (${response.status})`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  return bind(instance.exports as Exports);
}

function bind(exp: Exports): Kernel {
  const memory = () => new Uint8Array(exp.memory.buffer);
  let scratchPtr = 0;
  let scratchCap = 0;

  function scratch(size: number): number {
    if (size <= scratchCap) return scratchPtr;
    if (scratchCap > 0) exp.dealloc(scratchPtr, scratchCap);
    const cap = Math.max(size, Math.min(scratchCap * 2, 1024 * 1024), 64 * 1024);
    scratchPtr = exp.alloc(cap);
    scratchCap = cap;
    return scratchPtr;
  }

  function withBytes(bytes: Uint8Array, use: (ptr: number) => number): number {
    if (bytes.length === 0) return use(0);
    const ptr = scratch(bytes.length);
    memory().set(bytes, ptr);
    return use(ptr);
  }

  function withTwo(left: Uint8Array, right: Uint8Array, use: (leftPtr: number, rightPtr: number) => number): number {
    const ptr = scratch(left.length + right.length);
    const view = memory();
    if (left.length) view.set(left, ptr);
    if (right.length) view.set(right, ptr + left.length);
    return use(left.length ? ptr : 0, right.length ? ptr + left.length : 0);
  }

  function readError(): string {
    const cap = 1024;
    const ptr = exp.alloc(cap);
    try {
      const n = exp.last_error(ptr, cap);
      if (n < 0) return "内核报错，但错误信息放不进缓冲区";
      return decoder.decode(memory().subarray(ptr, ptr + n)) || "内核返回了空错误";
    } finally {
      exp.dealloc(ptr, cap);
    }
  }

  function readJson<T>(outPtr: number, written: number): T {
    if (written < 0) throw new Error(readError());
    return JSON.parse(decoder.decode(memory().subarray(outPtr, outPtr + written))) as T;
  }

  let outPtr = 0;
  let outCap = 0;

  function output(size: number): number {
    if (size <= outCap) return outPtr;
    if (outCap > 0) exp.dealloc(outPtr, outCap);
    outPtr = exp.alloc(size);
    outCap = size;
    return outPtr;
  }

  function invoke<T>(guess: number, run: (outPtr: number, cap: number) => number): T {
    let cap = Math.max(guess, outCap);
    for (let attempt = 0; attempt < 4; attempt++) {
      const ptr = output(cap);
      const written = run(ptr, cap);
      if (written >= 0) return readJson<T>(ptr, written);
      const message = readError();
      const need = message.match(/^need (\d+) bytes$/);
      if (!need) throw new Error(message);
      cap = Number(need[1]);
    }
    throw new Error("内核输出比预留的缓冲区大");
  }

  return {
    feed(carry, chunk, chunkOffset) {
      const guess = Math.max(65536, (carry.length + chunk.length) * 2 + 4096);
      const parsed = invoke<FeedJson>(guess, (outPtr, cap) =>
        withTwo(carry, chunk, (carryPtr, chunkPtr) =>
          exp.feed(carryPtr, carry.length, chunkPtr, chunk.length, chunkOffset >>> 0, outPtr, cap),
        ),
      );
      const raw = atob(parsed.carryB64);
      const next = new Uint8Array(new ArrayBuffer(raw.length));
      for (let i = 0; i < raw.length; i++) next[i] = raw.charCodeAt(i);
      return { carry: next, events: parsed.events };
    },
    finish(carry, carryOffset) {
      const guess = Math.max(65536, carry.length * 4 + 4096);
      return invoke(guess, (outPtr, cap) =>
        withBytes(carry, (ptr) => exp.finish(ptr, carry.length, carryOffset >>> 0, outPtr, cap)),
      );
    },
    parseUnary(body) {
      const guess = Math.max(65536, body.length * 2 + 4096);
      return invoke(guess, (outPtr, cap) =>
        withBytes(body, (ptr) => exp.parse_unary(ptr, body.length, outPtr, cap)),
      );
    },
    summarize(spec) {
      const bytes = encoder.encode(JSON.stringify(spec));
      const guess = Math.max(65536, bytes.length + 8192);
      return invoke(guess, (outPtr, cap) =>
        withBytes(bytes, (ptr) => exp.summarize(ptr, bytes.length, outPtr, cap)),
      );
    },
    aggregate(runs) {
      const bytes = encoder.encode(JSON.stringify(runs));
      const guess = Math.max(65536, bytes.length + 8192);
      return invoke(guess, (outPtr, cap) =>
        withBytes(bytes, (ptr) => exp.aggregate(ptr, bytes.length, outPtr, cap)),
      );
    },
    renderCard(input) {
      const bytes = encoder.encode(JSON.stringify(input));
      const guess = Math.max(65536, bytes.length + 8192);
      const { svg } = invoke<CardJson>(guess, (outPtr, cap) =>
        withBytes(bytes, (ptr) => exp.render_card(ptr, bytes.length, outPtr, cap)),
      );
      return svg;
    },
  };
}
