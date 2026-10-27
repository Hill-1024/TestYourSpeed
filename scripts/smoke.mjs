import { readFileSync } from "node:fs";

const bytes = readFileSync("web/src/wasm/io_kernel.wasm");
const { instance } = await WebAssembly.instantiate(bytes, {});
const exp = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();
const mem = () => new Uint8Array(exp.memory.buffer);

function withBytes(data, use) {
  if (!data.length) return use(0);
  const ptr = exp.alloc(data.length);
  try {
    mem().set(data, ptr);
    return use(ptr);
  } finally {
    exp.dealloc(ptr, data.length);
  }
}
function error() {
  const ptr = exp.alloc(512);
  try {
    const n = exp.last_error(ptr, 512);
    return dec.decode(mem().subarray(ptr, ptr + Math.max(n, 0)));
  } finally {
    exp.dealloc(ptr, 512);
  }
}
function call(guess, run) {
  let cap = guess;
  for (let i = 0; i < 3; i++) {
    const out = exp.alloc(cap);
    const n = run(out, cap);
    if (n >= 0) {
      const json = JSON.parse(dec.decode(mem().subarray(out, out + n)));
      exp.dealloc(out, cap);
      return json;
    }
    const message = error();
    exp.dealloc(out, cap);
    const need = message.match(/^need (\d+) bytes$/);
    if (!need) throw new Error(message);
    cap = Number(need[1]);
  }
  throw new Error("overflow");
}

const chunk = enc.encode(
  'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n' +
    "data: [DONE]\n\n",
);
const fed = call(8000, (out, cap) =>
  withBytes(new Uint8Array(), (cp) => withBytes(chunk, (ip) => exp.feed(cp, 0, ip, chunk.length, chunk.length, out, cap))),
);
if (fed.events[0].text !== "你好") throw new Error(JSON.stringify(fed));
if (fed.events[1].completionTokens !== 2) throw new Error("usage");

const report = call(8000, (out, cap) => {
  const spec = enc.encode(JSON.stringify({
    tHeadersMs: 40,
    tTotalMs: 540,
    requestBytes: 10,
    responseBytes: chunk.length,
    ticks: [
      { tMs: 120, kind: "content", text: "你", promptTokens: null, completionTokens: null, finishReason: null },
      { tMs: 520, kind: "content", text: "好", promptTokens: null, completionTokens: null, finishReason: "stop" },
      { tMs: 530, kind: "usage", text: "", promptTokens: 4, completionTokens: 2, finishReason: null },
    ],
  }));
  return withBytes(spec, (ptr) => exp.summarize(ptr, spec.length, out, cap));
});
if (report.ttftMs !== 120) throw new Error("ttft " + report.ttftMs);
if (Math.abs(report.tokensPerSec - 2.5) > 0.01) throw new Error("speed " + report.tokensPerSec);
console.log(JSON.stringify({ text: fed.events[0].text, ttft: report.ttftMs, speed: report.tokensPerSec }));
