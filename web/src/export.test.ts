import { describe, expect, it } from "vitest";
import type { Report, Summary } from "./kernel";
import { cardInput, filename, toCsv, toJson, type ExportMeta } from "./export";

const run: Report = {
  ok: true,
  error: null,
  warning: null,
  ttftMs: 120,
  totalMs: 540,
  ttfbMs: 40,
  tLastMs: 520,
  tokensPerSec: 50,
  e2eTokensPerSec: 20,
  itlMs: 20,
  promptTokens: 4,
  completionTokens: 10,
  estimated: false,
  truncated: false,
  windowShort: false,
  requestBytes: 100,
  responseBytes: 800,
  chars: 42,
};

const summary: Summary = {
  ok: true,
  error: null,
  ttftMs: 120,
  totalMs: 540,
  ttfbMs: 40,
  tokensPerSec: 50,
  e2eTokensPerSec: 20,
  itlMs: 20,
  promptTokens: 4,
  completionTokens: 10,
  estimated: false,
  truncated: false,
  windowShort: false,
  requestBytes: 100,
  responseBytes: 800,
  chars: 42,
  warning: null,
  runs: [run],
};

const meta: ExportMeta = { model: "gpt-5 mini", protocol: "Chat Completions", date: "2026-10-28" };

describe("cardInput", () => {
  it("maps the summary onto the kernel's card shape", () => {
    expect(cardInput(summary, meta)).toEqual({
      model: "gpt-5 mini",
      protocol: "Chat Completions",
      runs: 1,
      date: "2026-10-28",
      ttftMs: 120,
      totalMs: 540,
      tokensPerSec: 50,
      e2eTokensPerSec: 20,
      itlMs: 20,
      promptTokens: 4,
      completionTokens: 10,
      chars: 42,
      estimated: false,
      truncated: false,
      windowShort: false,
    });
  });
});

describe("toJson", () => {
  it("keeps the summary and every measurement", () => {
    const parsed = JSON.parse(toJson(summary, meta)) as {
      tool: string;
      model: string;
      summary: { ttftMs: number };
      measurements: unknown[];
    };
    expect(parsed.tool).toBe("TestYourSpeed");
    expect(parsed.model).toBe("gpt-5 mini");
    expect(parsed.summary.ttftMs).toBe(120);
    expect(parsed.measurements).toHaveLength(1);
  });
});

describe("toCsv", () => {
  it("writes a header, one row per run and a summary row", () => {
    const lines = toCsv(summary, meta).trim().split("\n");
    expect(lines[0]).toBe("# TestYourSpeed 2026-10-28 · gpt-5 mini · Chat Completions");
    expect(lines[1]).toBe(
      "run,ok,ttft_ms,total_ms,ttfb_ms,tokens_per_sec,e2e_tokens_per_sec,itl_ms,prompt_tokens,completion_tokens,estimated,truncated,error",
    );
    expect(lines[2]).toBe("run-1,true,120,540,40,50,20,20,4,10,false,false,");
    expect(lines[3]).toBe("summary,true,120,540,40,50,20,20,4,10,false,false,");
  });

  it("quotes errors that contain commas", () => {
    const failed: Report = { ...run, ok: false, error: "接口返回 400：bad, very bad" };
    const csv = toCsv({ ...summary, runs: [failed] }, meta);
    expect(csv).toContain('"接口返回 400：bad, very bad"');
  });
});

describe("filename", () => {
  it("slugs the model name", () => {
    expect(filename(meta, "png")).toBe("testyourspeed-gpt-5-mini-2026-10-28.png");
    expect(filename({ ...meta, model: "  " }, "csv")).toBe("testyourspeed-measurement-2026-10-28.csv");
  });
});
