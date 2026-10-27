export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatSpeed(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return "—";
  if (tokens >= 100) return `${tokens.toFixed(0)} tok/s`;
  return `${tokens.toFixed(1)} tok/s`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  return String(n);
}
