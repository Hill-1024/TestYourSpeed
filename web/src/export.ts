import type { CardInput, Kernel, Summary } from "./kernel";

export type ExportMeta = {
  model: string;
  protocol: string;
  date: string;
};

type Row = {
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
};

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const CARD_SCALE = 2;

/** Flatten the summary into the shape the kernel draws. */
export function cardInput(summary: Summary, meta: ExportMeta): CardInput {
  return {
    model: meta.model,
    protocol: meta.protocol,
    runs: summary.runs.length,
    date: meta.date,
    ttftMs: summary.ttftMs,
    totalMs: summary.totalMs,
    tokensPerSec: summary.tokensPerSec,
    e2eTokensPerSec: summary.e2eTokensPerSec,
    itlMs: summary.itlMs,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    chars: summary.chars,
    estimated: summary.estimated,
    truncated: summary.truncated,
    windowShort: summary.windowShort,
  };
}

export function toJson(summary: Summary, meta: ExportMeta): string {
  return JSON.stringify(
    {
      tool: "TestYourSpeed",
      measuredAt: new Date().toISOString(),
      model: meta.model,
      protocol: meta.protocol,
      runs: summary.runs.length,
      summary: {
        ok: summary.ok,
        error: summary.error,
        ttftMs: summary.ttftMs,
        totalMs: summary.totalMs,
        ttfbMs: summary.ttfbMs,
        tokensPerSec: summary.tokensPerSec,
        e2eTokensPerSec: summary.e2eTokensPerSec,
        itlMs: summary.itlMs,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        estimated: summary.estimated,
        truncated: summary.truncated,
        windowShort: summary.windowShort,
        responseBytes: summary.responseBytes,
        chars: summary.chars,
      },
      measurements: summary.runs.map((run) => ({
        ok: run.ok,
        error: run.error,
        ttftMs: run.ttftMs,
        totalMs: run.totalMs,
        ttfbMs: run.ttfbMs,
        tokensPerSec: run.tokensPerSec,
        e2eTokensPerSec: run.e2eTokensPerSec,
        itlMs: run.itlMs,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        estimated: run.estimated,
        truncated: run.truncated,
      })),
    },
    null,
    2,
  );
}

const CSV_COLUMNS = [
  "run",
  "ok",
  "ttft_ms",
  "total_ms",
  "ttfb_ms",
  "tokens_per_sec",
  "e2e_tokens_per_sec",
  "itl_ms",
  "prompt_tokens",
  "completion_tokens",
  "estimated",
  "truncated",
  "error",
] as const;

export function toCsv(summary: Summary, meta: ExportMeta): string {
  const rows: string[][] = [
    [...CSV_COLUMNS],
    ...summary.runs.map((run, index) => runRow(`run-${index + 1}`, run)),
    runRow("summary", {
      ok: summary.ok,
      error: summary.error,
      ttftMs: summary.ttftMs,
      totalMs: summary.totalMs ?? 0,
      ttfbMs: summary.ttfbMs ?? 0,
      tokensPerSec: summary.tokensPerSec,
      e2eTokensPerSec: summary.e2eTokensPerSec,
      itlMs: summary.itlMs,
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      estimated: summary.estimated,
      truncated: summary.truncated,
    }),
  ];
  const head = `# TestYourSpeed ${meta.date} · ${meta.model} · ${meta.protocol}`;
  return `${head}\n${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function runRow(label: string, run: Row): string[] {
  return [
    label,
    run.ok ? "true" : "false",
    cell(run.ttftMs),
    cell(run.totalMs),
    cell(run.ttfbMs),
    cell(run.tokensPerSec),
    cell(run.e2eTokensPerSec),
    cell(run.itlMs),
    cell(run.promptTokens),
    cell(run.completionTokens),
    run.estimated ? "true" : "false",
    run.truncated ? "true" : "false",
    csvCell(run.error ?? ""),
  ];
}

function cell(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "" : String(Math.round(value * 100) / 100);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render the card with the kernel, then rasterise it on this machine. */
export async function cardPng(kernel: Kernel, summary: Summary, meta: ExportMeta): Promise<Blob> {
  const svg = kernel.renderCard(cardInput(summary, meta));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("卡片图片没能渲染出来"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = CARD_WIDTH * CARD_SCALE;
    canvas.height = CARD_HEIGHT * CARD_SCALE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("这台机器没有可用的画布");
    context.fillStyle = "#f4f7fb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filename(meta: ExportMeta, extension: string): string {
  const slug = meta.model.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "measurement";
  return `testyourspeed-${slug}-${meta.date}.${extension}`;
}
