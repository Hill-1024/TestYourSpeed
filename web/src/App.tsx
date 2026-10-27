import { useEffect, useRef, useState } from "react";
import { loadKernel, type Kernel, type Report, type Summary } from "./kernel";
import { listModels, probeOnce, type ApiKind, type ProbePhase, type ProbeRequest } from "./probe";
import { formatCount, formatMs, formatSpeed } from "./format";

const APIS: { id: ApiKind; label: string }[] = [
  { id: "chat", label: "Chat Completions" },
  { id: "responses", label: "Responses" },
  { id: "anthropic", label: "Messages" },
];

const DEFAULT_PROMPT = "用三句话说明什么是首 token 延迟，不要使用列表。";

type Live = {
  text: string;
  run: number;
  runs: number;
};

export function App() {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [api, setApi] = useState<ApiKind>("chat");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState("256");
  const [runs, setRuns] = useState("1");
  const [modelsUrl, setModelsUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ProbePhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const modelsRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadKernel()
      .then((loaded) => {
        if (!cancelled) setKernel(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBootError(err instanceof Error ? err.message : "内核没有起来");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function start() {
    if (!kernel || busy) return;
    const count = wholeNumber(runs);
    const tokens = wholeNumber(maxTokens);
    if (count === null || count < 1) {
      setError("次数要是大于 0 的整数");
      return;
    }
    if (tokens === null || tokens < 1) {
      setError("最多 token 要是大于 0 的整数");
      return;
    }
    if (!model.trim()) {
      setError("先填写模型");
      return;
    }
    if (!prompt.trim()) {
      setError("先填写提示词");
      return;
    }
    setBusy(true);
    setPhase("sent");
    setRevealed(true);
    setError(null);
    setSummary(null);
    const req: ProbeRequest = {
      api,
      endpoint,
      apiKey,
      model: model.trim(),
      prompt,
      maxTokens: tokens,
      temperature: 0,
      onPhase: setPhase,
    };
    const reports: Report[] = [];
    const controller = new AbortController();
    try {
      for (let index = 0; index < count; index++) {
        setLive({ text: "", run: index + 1, runs: count });
        const { report, text } = await probeOnce(kernel, req, controller.signal);
        reports.push(report);
        setLive({ text, run: index + 1, runs: count });
        if (!report.ok && count === 1) break;
        if (index < count - 1) await wait(700);
      }
      setSummary(kernel.aggregate(reports));
    } catch (err) {
      setError(err instanceof Error ? err.message : "测速失败");
    } finally {
      setBusy(false);
    }
  }

  function loadModels() {
    modelsRequest.current?.abort();
    const controller = new AbortController();
    modelsRequest.current = controller;
    listModels(endpoint, modelsUrl, apiKey, api, controller.signal)
      .then((ids) => {
        if (controller.signal.aborted) return;
        setModels(ids);
        setModelsError(ids.length ? null : "模型列表是空的");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : "拉不到模型列表");
      });
  }

  useEffect(() => () => modelsRequest.current?.abort(), []);

  return (
    <div className="page">
      <header className="mast">
        <h1>Test Your Speed</h1>
        <p className="lede">
          基于 WASM 的 LLM 测速工具，无状态无需担心密钥泄露，一切跑在你的电脑上。
        </p>
      </header>

      <section className="bench" aria-label="测速">
        <form
          className="controls"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <fieldset className="field">
            <legend>协议</legend>
            <div className="segment">
              {APIS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={api === item.id ? "on" : ""}
                  onClick={() => setApi(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>接口</span>
            <input
              value={endpoint}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://host/v1"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label className="field">
            <span>密钥</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="只放在这次请求里"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <div className="split">
            <div className="field">
              <span>模型</span>
              <div className="combo">
                <input
                  value={model}
                  spellCheck={false}
                  aria-label="模型"
                  aria-expanded={modelsOpen}
                  aria-activedescendant={modelsOpen ? "model-active" : undefined}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setModelCursor(0);
                    setModelsOpen(true);
                    if (models.length === 0 && !modelsError) loadModels();
                  }}
                  onKeyDown={(event) => {
                    const matched = matchingModels(models, model);
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setModelsOpen(true);
                      if (models.length === 0 && !modelsError) loadModels();
                      if (!matched.length) return;
                      const step = event.key === "ArrowDown" ? 1 : -1;
                      setModelCursor((current) => (current + step + matched.length) % matched.length);
                    } else if ((event.key === "Enter" || event.key === "Tab") && modelsOpen && matched[modelCursor]) {
                      event.preventDefault();
                      setModel(matched[modelCursor]);
                      setModelsOpen(false);
                    } else if (event.key === "Escape") {
                      setModelsOpen(false);
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="展开模型列表"
                  aria-expanded={modelsOpen}
                  onClick={() => {
                    const next = !modelsOpen;
                    setModelsOpen(next);
                    if (next) loadModels();
                  }}
                >
                  ▾
                </button>
                {modelsOpen && (
                  <ModelMenu
                    models={models}
                    query={model}
                    cursor={modelCursor}
                    error={modelsError}
                    onPick={(id) => {
                      setModel(id);
                      setModelsOpen(false);
                    }}
                  />
                )}
              </div>
            </div>
            <label className="field">
              <span>最多 token</span>
              <input
                inputMode="numeric"
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </label>
            <label className="field">
              <span>次数</span>
              <input
                inputMode="numeric"
                value={runs}
                onChange={(event) => setRuns(event.target.value)}
              />
            </label>
          </div>
          {modelsError && <p className="fail">{modelsError}</p>}
          <details className="advanced">
            <summary>高级设置</summary>
            <label className="field">
              <span>模型列表地址</span>
              <input
                value={modelsUrl}
                autoComplete="off"
                spellCheck={false}
                placeholder="留空则请求 /models"
                onChange={(event) => setModelsUrl(event.target.value)}
              />
            </label>
          </details>
          <label className="field">
            <span>提示词</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <div className="run">
            <button className="go" type="submit" disabled={!kernel || busy}>
              {busy ? "正在测…" : kernel ? "开始测速" : "内核加载中"}
            </button>
          </div>
          {bootError && <p className="fail">{bootError}</p>}
          {error && <p className="fail">{error}</p>}
        </form>

        {revealed && (
        <div className="readout" aria-live="polite">
          <Progress phase={phase} run={live?.run ?? 0} runs={live?.runs ?? 0} />
          <Figures summary={summary} />
          {live && live.text && (
            <details className="once" open>
              <summary>
                输出{live.runs > 1 ? ` · 第 ${live.run} 次` : ""}
              </summary>
              <pre>{live.text}</pre>
            </details>
          )}
        </div>
        )}
      </section>

      <footer>
        <p>
          首 token 从发出请求算到第一段正文。输出速度只算这之后的间隔，用接口返回的 completion token；没有 usage 时按文本估算，并标明。多次测量取中位数，速度取平均。
        </p>
      </footer>
    </div>
  );
}

const PHASES: { id: ProbePhase; label: string }[] = [
  { id: "sent", label: "发出" },
  { id: "waiting", label: "等待响应" },
  { id: "streaming", label: "开始响应" },
  { id: "done", label: "响应结束" },
];

function Progress({ phase, run, runs }: { phase: ProbePhase | null; run: number; runs: number }) {
  if (!phase) return null;
  const current = Math.max(0, PHASES.findIndex((item) => item.id === phase));
  const fill = `${((current + 1) / PHASES.length) * 100}%`;
  return (
    <div className="progress" aria-label={`第 ${run} 轮，共 ${runs} 轮`}>
      <p>
        第 {run} / {runs} 轮
      </p>
      <div className="meter">
        <div className="track">
          <span style={{ width: fill }} />
        </div>
        {phase === "done" && (
          <span className="check" key={run} aria-label="响应结束">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" pathLength="1" />
              <path d="m9 12 2 2 4-4" pathLength="1" />
            </svg>
          </span>
        )}
      </div>
      <ol>
        {PHASES.map((item, index) => (
          <li key={item.id} className={index < current ? "past" : index === current ? "now" : ""}>
            {item.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function matchingModels(models: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? models.filter((id) => id.toLowerCase().includes(needle)) : models;
}

function ModelMenu({
  models,
  query,
  cursor,
  error,
  onPick,
}: {
  models: string[];
  query: string;
  cursor: number;
  error: string | null;
  onPick: (id: string) => void;
}) {
  const matched = matchingModels(models, query);
  const active = Math.min(cursor, Math.max(matched.length - 1, 0));
  return (
    <ul className="menu" role="listbox">
      {models.length === 0 && <li className="quiet">{error ?? "正在拉取"}</li>}
      {models.length > 0 && matched.length === 0 && <li className="quiet">没有匹配的模型</li>}
      {matched.map((id, index) => (
        <li key={id} id={index === active ? "model-active" : undefined} role="option" aria-selected={index === active}>
          <button type="button" className={index === active ? "on" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(id)}>
            {id}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Figures({ summary }: { summary: Summary | null }) {
  if (!summary) {
    return (
      <div className="empty">
        <p className="figure">—</p>
        <p>填好接口和模型后开始。右边最先出现的是首 token 时间。</p>
      </div>
    );
  }
  if (!summary.ok) {
    return (
      <div className="empty">
        <p className="figure">失败</p>
        <p>{summary.error}</p>
      </div>
    );
  }
  return (
    <div className="figures">
      <p className="eyebrow">首 token</p>
      <p className="figure">{formatMs(summary.ttftMs)}</p>
      <dl>
        <div>
          <dt>响应时间</dt>
          <dd>{formatMs(summary.totalMs)}</dd>
        </div>
        <div>
          <dt>输出速度</dt>
          <dd>{formatSpeed(summary.tokensPerSec)}</dd>
        </div>
        <div>
          <dt>整段速度</dt>
          <dd>{formatSpeed(summary.e2eTokensPerSec)}</dd>
        </div>
        <div>
          <dt>token 间隔</dt>
          <dd>{formatMs(summary.itlMs)}</dd>
        </div>
        <div>
          <dt>输入 token</dt>
          <dd>{formatCount(summary.promptTokens)}</dd>
        </div>
        <div>
          <dt>输出 token</dt>
          <dd>{formatCount(summary.completionTokens)}</dd>
        </div>
      </dl>
      <Notes summary={summary} />
      {summary.runs.length > 1 && (
        <ol className="runs">
          {summary.runs.map((run, index) => (
            <li key={index}>
              {run.ok
                ? `${formatMs(run.ttftMs)} · ${formatSpeed(run.tokensPerSec)} · ${formatMs(run.totalMs)}`
                : run.error}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Notes({ summary }: { summary: Summary }) {
  const notes: string[] = [];
  if (summary.estimated) notes.push("接口没有返回用量，输出 token 是按文本估算的");
  if (summary.windowShort) notes.push("输出太短，速度含首 token，不能单独看生成");
  if (summary.truncated) notes.push("输出被长度上限截断");
  if (summary.warning) notes.push(summary.warning);
  if (summary.runs.length > 1) notes.push(`${summary.runs.length} 次，时间取中位数`);
  if (!notes.length) return null;
  return (
    <ul className="notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function wholeNumber(value: string): number | null {
  const text = value.trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
