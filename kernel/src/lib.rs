//! Stateless LLM stream kernel.
//!
//! The page records when each byte chunk arrives. This module only parses
//! those bytes and turns the timestamps into response time, TTFT and output
//! speed. Every call takes the carry (or the whole sample) as an argument
//! and returns a new one. Nothing about a run is kept inside the module.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

const MAX_INPUT: usize = 16 * 1024 * 1024;

thread_local! {
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Event {
    at: usize,
    kind: String,
    text: String,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tick {
    t_ms: f64,
    kind: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    t_headers_ms: f64,
    t_total_ms: f64,
    request_bytes: usize,
    response_bytes: usize,
    ticks: Vec<Tick>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    ok: bool,
    error: Option<String>,
    warning: Option<String>,
    ttft_ms: Option<f64>,
    total_ms: f64,
    ttfb_ms: f64,
    t_last_ms: Option<f64>,
    tokens_per_sec: Option<f64>,
    e2e_tokens_per_sec: Option<f64>,
    itl_ms: Option<f64>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    estimated: bool,
    truncated: bool,
    window_short: bool,
    request_bytes: usize,
    response_bytes: usize,
    chars: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    ok: bool,
    error: Option<String>,
    ttft_ms: Option<f64>,
    total_ms: Option<f64>,
    ttfb_ms: Option<f64>,
    tokens_per_sec: Option<f64>,
    e2e_tokens_per_sec: Option<f64>,
    itl_ms: Option<f64>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    estimated: bool,
    truncated: bool,
    window_short: bool,
    request_bytes: usize,
    response_bytes: usize,
    chars: usize,
    warning: Option<String>,
    runs: Vec<Report>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedJson<'a> {
    carry_b64: String,
    events: &'a [Event],
}

fn set_error(message: impl Into<String>) -> i32 {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = message.into().into_bytes();
    });
    -1
}

fn clear_error() {
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn write_bytes(bytes: &[u8], out_ptr: *mut u8, out_cap: usize) -> i32 {
    if bytes.len() > out_cap {
        return set_error(format!("need {} bytes", bytes.len()));
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    }
    clear_error();
    bytes.len() as i32
}

fn json_out<T: Serialize>(value: &T, out_ptr: *mut u8, out_cap: usize) -> i32 {
    match serde_json::to_vec(value) {
        Ok(bytes) => write_bytes(&bytes, out_ptr, out_cap),
        Err(error) => set_error(error.to_string()),
    }
}

fn read_bytes<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], String> {
    if len > MAX_INPUT {
        return Err(format!("输入超过 {MAX_INPUT} 字节"));
    }
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err("空指针".to_string());
    }
    Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

fn lines_of(block: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in block.iter().enumerate() {
        if *byte == b'\n' {
            let mut line = &block[start..index];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            lines.push(line);
            start = index + 1;
        }
    }
    if start < block.len() {
        let mut line = &block[start..];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        lines.push(line);
    }
    lines
}

/// Split a buffer into finished SSE events and the unfinished tail.
/// The tail is everything since the last blank line, so the caller can
/// hand it back on the next chunk. The kernel does not keep it.
fn drain(buf: &[u8], base: usize) -> (Vec<u8>, Vec<Event>) {
    let mut events = Vec::new();
    let mut line_start = 0;
    let mut event_start = 0;
    let mut index = 0;
    while index < buf.len() {
        if buf[index] != b'\n' {
            index += 1;
            continue;
        }
        let mut line = &buf[line_start..index];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        let next = index + 1;
        if line.is_empty() && line_start > event_start {
            events.extend(parse_event(&buf[event_start..line_start], base + event_start));
            event_start = next;
        }
        line_start = next;
        index = next;
    }
    (buf[event_start..].to_vec(), events)
}

fn parse_event(block: &[u8], at: usize) -> Vec<Event> {
    let mut data: Vec<u8> = Vec::new();
    let mut saw_data = false;
    for line in lines_of(block) {
        let Some(rest) = line.strip_prefix(b"data:") else {
            continue;
        };
        let rest = rest.strip_prefix(b" ").unwrap_or(rest);
        if saw_data {
            data.push(b'\n');
        }
        data.extend_from_slice(rest);
        saw_data = true;
    }
    if !saw_data {
        return Vec::new();
    }
    events_from_data(&data, at)
}

fn events_from_data(data: &[u8], at: usize) -> Vec<Event> {
    if data == b"[DONE]" {
        return vec![Event {
            at,
            kind: "done".to_string(),
            text: String::new(),
            prompt_tokens: None,
            completion_tokens: None,
            finish_reason: None,
        }];
    }
    match serde_json::from_slice::<Value>(data) {
        Ok(value) => events_from_json(&value, at),
        Err(_) => vec![Event {
            at,
            kind: "error".to_string(),
            text: "有一帧数据不是 JSON".to_string(),
            prompt_tokens: None,
            completion_tokens: None,
            finish_reason: None,
        }],
    }
}

fn events_from_json(value: &Value, at: usize) -> Vec<Event> {
    let mut events = Vec::new();
    if let Some(message) = error_message(value) {
        events.push(error_event(at, message));
    }

    // Chat Completions: choices[].delta / choices[].message
    if let Some(choices) = value.get("choices").and_then(|choices| choices.as_array()) {
        for choice in choices.iter().take(1) {
            if let Some(event) = chat_choice(choice, at) {
                events.push(event);
            }
        }
    }

    // Responses: { type, delta } and output[].content[]
    events.extend(responses_events(value, at));

    // Anthropic Messages: { type, delta } and content[]
    events.extend(anthropic_events(value, at));

    if let Some(usage) = usage_event(value, at) {
        events.push(usage);
    }
    events
}

fn error_event(at: usize, text: String) -> Event {
    Event {
        at,
        kind: "error".to_string(),
        text,
        prompt_tokens: None,
        completion_tokens: None,
        finish_reason: None,
    }
}

fn content_event(at: usize, text: String, finish: Option<String>) -> Event {
    Event {
        at,
        kind: "content".to_string(),
        text,
        prompt_tokens: None,
        completion_tokens: None,
        finish_reason: finish,
    }
}

fn chat_choice(choice: &Value, at: usize) -> Option<Event> {
    let payload = choice.get("delta").or_else(|| choice.get("message"))?;
    let mut text = String::new();
    for key in ["reasoning_content", "reasoning", "content"] {
        if let Some(piece) = payload.get(key) {
            text.push_str(&value_text(piece));
        }
    }
    let finish = choice
        .get("finish_reason")
        .and_then(|reason| reason.as_str())
        .filter(|reason| !reason.is_empty())
        .map(str::to_string);
    if text.is_empty() && finish.is_none() {
        return None;
    }
    Some(content_event(at, text, finish))
}

fn responses_events(value: &Value, at: usize) -> Vec<Event> {
    let mut events = Vec::new();
    let kind = value.get("type").and_then(|kind| kind.as_str()).unwrap_or("");
    match kind {
        "response.output_text.delta" | "response.reasoning_summary_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(|delta| delta.as_str()) {
                if !delta.is_empty() {
                    events.push(content_event(at, delta.to_string(), None));
                }
            }
        }
        "response.completed" | "response.incomplete" => {
            // Text already arrived as deltas. This frame is only the final
            // object, so taking output[] again would double the transcript.
            if kind == "response.incomplete" {
                events.push(content_event(at, String::new(), Some("length".to_string())));
            }
        }
        "error" => {
            if let Some(message) = value
                .get("message")
                .and_then(|message| message.as_str())
            {
                events.push(error_event(at, message.to_string()));
            }
        }
        _ => {}
    }
    if kind.is_empty() {
        events.extend(output_items(value, at));
    }
    events
}

fn output_items(value: &Value, at: usize) -> Vec<Event> {
    let Some(output) = value.get("output").and_then(|output| output.as_array()) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for item in output {
        let Some(parts) = item.get("content").and_then(|content| content.as_array()) else {
            continue;
        };
        let mut text = String::new();
        for part in parts {
            let part_type = part.get("type").and_then(|kind| kind.as_str()).unwrap_or("");
            if part_type == "output_text" || part_type == "text" || part_type.is_empty() {
                if let Some(piece) = part.get("text").and_then(|text| text.as_str()) {
                    text.push_str(piece);
                }
            }
        }
        if !text.is_empty() {
            events.push(content_event(at, text, None));
        }
    }
    events
}

fn anthropic_events(value: &Value, at: usize) -> Vec<Event> {
    let mut events = Vec::new();
    let kind = value.get("type").and_then(|kind| kind.as_str()).unwrap_or("");
    match kind {
        "content_block_delta" => {
            if let Some(delta) = value.get("delta") {
                let piece = delta
                    .get("text")
                    .or_else(|| delta.get("thinking"))
                    .or_else(|| delta.get("partial_json"))
                    .and_then(|text| text.as_str())
                    .unwrap_or("");
                if !piece.is_empty() {
                    events.push(content_event(at, piece.to_string(), None));
                }
            }
        }
        "message_delta" => {
            if let Some(reason) = value
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(|reason| reason.as_str())
            {
                events.push(content_event(at, String::new(), Some(map_stop(reason))));
            }
            if let Some(usage) = value.get("usage") {
                let completion = json_u32(usage.get("output_tokens"));
                if completion.is_some() {
                    events.push(Event {
                        at,
                        kind: "usage".to_string(),
                        text: String::new(),
                        prompt_tokens: None,
                        completion_tokens: completion,
                        finish_reason: None,
                    });
                }
            }
        }
        "message_start" => {
            if let Some(message) = value.get("message") {
                events.extend(anthropic_blocks(message, at));
                if let Some(usage) = message.get("usage") {
                    let prompt = json_u32(usage.get("input_tokens"));
                    if prompt.is_some() {
                        events.push(Event {
                            at,
                            kind: "usage".to_string(),
                            text: String::new(),
                            prompt_tokens: prompt,
                            completion_tokens: None,
                            finish_reason: None,
                        });
                    }
                }
            }
        }
        "error" => {
            if let Some(message) = error_message(value) {
                events.push(error_event(at, message));
            }
        }
        _ => {}
    }
    if kind.is_empty() {
        events.extend(anthropic_blocks(value, at));
        if let Some(reason) = value.get("stop_reason").and_then(|reason| reason.as_str()) {
            events.push(content_event(at, String::new(), Some(map_stop(reason))));
        }
    }
    events
}

fn anthropic_blocks(value: &Value, at: usize) -> Vec<Event> {
    let Some(blocks) = value.get("content").and_then(|content| content.as_array()) else {
        return Vec::new();
    };
    let mut text = String::new();
    for block in blocks {
        let block_type = block.get("type").and_then(|kind| kind.as_str()).unwrap_or("");
        if block_type == "text" || block_type == "thinking" || block_type.is_empty() {
            if let Some(piece) = block.get("text").or_else(|| block.get("thinking")) {
                text.push_str(&value_text(piece));
            }
        }
    }
    if text.is_empty() {
        Vec::new()
    } else {
        vec![content_event(at, text, None)]
    }
}

fn map_stop(reason: &str) -> String {
    match reason {
        "max_tokens" | "length" => "length".to_string(),
        other => other.to_string(),
    }
}

fn usage_event(value: &Value, at: usize) -> Option<Event> {
    let usage = value
        .get("usage")
        .or_else(|| value.get("response").and_then(|response| response.get("usage")))
        .or_else(|| value.get("message").and_then(|message| message.get("usage")))?;
    let prompt = json_u32(usage.get("prompt_tokens"))
        .or_else(|| json_u32(usage.get("input_tokens")));
    let completion = json_u32(usage.get("completion_tokens"))
        .or_else(|| json_u32(usage.get("output_tokens")));
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    Some(Event {
        at,
        kind: "usage".to_string(),
        text: String::new(),
        prompt_tokens: prompt,
        completion_tokens: completion,
        finish_reason: None,
    })
}

fn error_message(value: &Value) -> Option<String> {
    let err = value.get("error")?;
    if let Some(text) = err.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = err.get("message").and_then(|message| message.as_str()) {
        return Some(text.to_string());
    }
    None
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|text| text.as_str())
                    .or_else(|| part.as_str())
            })
            .collect(),
        _ => String::new(),
    }
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    value.and_then(|value| {
        value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .or_else(|| value.as_i64().and_then(|n| u32::try_from(n).ok()))
    })
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{3040}'..='\u{30FF}'
            | '\u{AC00}'..='\u{D7AF}'
    )
}

/// Rough stand-in used only when the API does not report `usage`.
fn estimate_tokens(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let mut ascii = 0.0;
    let mut cjk = 0.0;
    let mut other = 0.0;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1.0;
        } else if is_cjk(ch) {
            cjk += 1.0;
        } else {
            other += 1.0;
        }
    }
    let estimate: f64 = ascii / 4.0 + cjk / 1.5 + other / 2.0;
    estimate.ceil() as u32
}

fn summarize_spec(spec: Spec) -> Report {
    let mut text = String::new();
    let mut content_times: Vec<f64> = Vec::new();
    let mut prompt_tokens = None;
    let mut completion_tokens = None;
    let mut truncated = false;
    let mut hard_error = None;
    let mut warning = None;

    for tick in &spec.ticks {
        match tick.kind.as_str() {
            "content" => {
                if !tick.text.is_empty() {
                    text.push_str(&tick.text);
                    content_times.push(tick.t_ms);
                }
                if matches!(tick.finish_reason.as_deref(), Some("length" | "max_tokens")) {
                    truncated = true;
                }
            }
            "usage" => {
                if tick.prompt_tokens.is_some() {
                    prompt_tokens = tick.prompt_tokens;
                }
                if tick.completion_tokens.is_some() {
                    completion_tokens = tick.completion_tokens;
                }
            }
            "error" => {
                if !tick.text.is_empty() && hard_error.is_none() {
                    hard_error = Some(tick.text.clone());
                }
            }
            _ => {}
        }
    }

    let usage_completion = completion_tokens.filter(|n| *n > 0);
    let estimated_n = estimate_tokens(&text);
    let (n, estimated) = match usage_completion {
        Some(tokens) => (tokens, false),
        None => (estimated_n, estimated_n > 0),
    };

    let ttft = content_times.iter().copied().reduce(f64::min);
    let t_last = content_times.iter().copied().reduce(f64::max);
    let window = match (ttft, t_last) {
        (Some(first), Some(last)) => (last - first).max(0.0),
        _ => 0.0,
    };

    let mut tokens_per_sec = None;
    let mut itl_ms = None;
    let mut window_short = false;
    if n >= 2 && window >= 1.0 {
        let itl = window / f64::from(n - 1);
        itl_ms = Some(itl);
        tokens_per_sec = Some(1000.0 / itl);
    } else if n >= 1 && spec.t_total_ms > 0.0 {
        window_short = true;
        tokens_per_sec = Some(f64::from(n) / (spec.t_total_ms / 1000.0));
    }

    let e2e = if n >= 1 && spec.t_total_ms > 0.0 {
        Some(f64::from(n) / (spec.t_total_ms / 1000.0))
    } else {
        None
    };

    if let Some(message) = hard_error.clone() {
        if text.is_empty() {
            return Report {
                ok: false,
                error: Some(message),
                warning: None,
                ttft_ms: ttft,
                total_ms: spec.t_total_ms,
                ttfb_ms: spec.t_headers_ms,
                t_last_ms: t_last,
                tokens_per_sec: None,
                e2e_tokens_per_sec: None,
                itl_ms: None,
                prompt_tokens,
                completion_tokens: usage_completion,
                estimated: false,
                truncated,
                window_short: false,
                request_bytes: spec.request_bytes,
                response_bytes: spec.response_bytes,
                chars: 0,
            };
        }
        warning = Some(message);
    }

    if text.is_empty() && n == 0 {
        return Report {
            ok: false,
            error: Some("没有收到输出".to_string()),
            warning: None,
            ttft_ms: None,
            total_ms: spec.t_total_ms,
            ttfb_ms: spec.t_headers_ms,
            t_last_ms: None,
            tokens_per_sec: None,
            e2e_tokens_per_sec: None,
            itl_ms: None,
            prompt_tokens,
            completion_tokens: usage_completion,
            estimated: false,
            truncated,
            window_short: false,
            request_bytes: spec.request_bytes,
            response_bytes: spec.response_bytes,
            chars: 0,
        };
    }

    Report {
        ok: true,
        error: None,
        warning,
        ttft_ms: ttft,
        total_ms: spec.t_total_ms,
        ttfb_ms: spec.t_headers_ms,
        t_last_ms: t_last,
        tokens_per_sec,
        e2e_tokens_per_sec: e2e,
        itl_ms,
        prompt_tokens,
        completion_tokens: Some(n),
        estimated,
        truncated,
        window_short,
        request_bytes: spec.request_bytes,
        response_bytes: spec.response_bytes,
        chars: text.chars().count(),
    }
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[mid])
    } else {
        Some((values[mid - 1] + values[mid]) / 2.0)
    }
}

fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

fn mean_count(values: impl Iterator<Item = Option<u32>>) -> Option<u32> {
    let nums: Vec<u32> = values.flatten().collect();
    if nums.is_empty() {
        return None;
    }
    let sum: f64 = nums.iter().map(|n| f64::from(*n)).sum();
    Some((sum / nums.len() as f64).round() as u32)
}

fn aggregate_runs(runs: Vec<Report>) -> Summary {
    let ok_runs: Vec<&Report> = runs.iter().filter(|run| run.ok).collect();
    if ok_runs.is_empty() {
        let error = runs.iter().find_map(|run| run.error.clone());
        return Summary {
            ok: false,
            error: error.or_else(|| Some("没有成功的测量".to_string())),
            ttft_ms: None,
            total_ms: None,
            ttfb_ms: None,
            tokens_per_sec: None,
            e2e_tokens_per_sec: None,
            itl_ms: None,
            prompt_tokens: None,
            completion_tokens: None,
            estimated: false,
            truncated: false,
            window_short: false,
            request_bytes: 0,
            response_bytes: 0,
            chars: 0,
            warning: None,
            runs,
        };
    }

    let mut ttfts: Vec<f64> = ok_runs.iter().filter_map(|run| run.ttft_ms).collect();
    let mut totals: Vec<f64> = ok_runs.iter().map(|run| run.total_ms).collect();
    let mut ttfbs: Vec<f64> = ok_runs.iter().map(|run| run.ttfb_ms).collect();
    let mut itls: Vec<f64> = ok_runs.iter().filter_map(|run| run.itl_ms).collect();
    let speeds: Vec<f64> = ok_runs.iter().filter_map(|run| run.tokens_per_sec).collect();
    let e2e: Vec<f64> = ok_runs
        .iter()
        .filter_map(|run| run.e2e_tokens_per_sec)
        .collect();

    let single = ok_runs.len() == 1;
    let last = *ok_runs.last().expect("at least one");
    let warning = if runs.len() != ok_runs.len() {
        Some(format!("{} 次里有失败", runs.len()))
    } else if single {
        last.warning.clone()
    } else {
        None
    };

    Summary {
        ok: true,
        error: None,
        ttft_ms: median(&mut ttfts),
        total_ms: median(&mut totals),
        ttfb_ms: median(&mut ttfbs),
        tokens_per_sec: mean(&speeds),
        e2e_tokens_per_sec: mean(&e2e),
        itl_ms: median(&mut itls),
        prompt_tokens: if single {
            last.prompt_tokens
        } else {
            mean_count(ok_runs.iter().map(|run| run.prompt_tokens))
        },
        completion_tokens: if single {
            last.completion_tokens
        } else {
            mean_count(ok_runs.iter().map(|run| run.completion_tokens))
        },
        estimated: ok_runs.iter().any(|run| run.estimated),
        truncated: ok_runs.iter().any(|run| run.truncated),
        window_short: ok_runs.iter().all(|run| run.window_short),
        request_bytes: if single { last.request_bytes } else { 0 },
        response_bytes: if single { last.response_bytes } else { 0 },
        chars: if single { last.chars } else { 0 },
        warning,
        runs,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CardInput {
    model: String,
    protocol: String,
    runs: usize,
    date: String,
    ttft_ms: Option<f64>,
    total_ms: Option<f64>,
    tokens_per_sec: Option<f64>,
    e2e_tokens_per_sec: Option<f64>,
    itl_ms: Option<f64>,
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    chars: usize,
    estimated: bool,
    truncated: bool,
    window_short: bool,
}

#[derive(Serialize)]
struct CardJson {
    svg: String,
}

const CARD_FONT: &str = "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace";
const CARD_INK: &str = "#172033";
const CARD_QUIET: &str = "#5c6b82";
const CARD_RULE: &str = "#dde6f1";
const CARD_PAPER: &str = "#f4f7fb";

fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

fn clamp_chars(value: &str, max: usize) -> String {
    let mut out: String = value.chars().take(max).collect();
    if value.chars().count() > max {
        out.pop();
        out.push('…');
    }
    out
}

/// Mirrors `web/src/format.ts` so the card and the page show the same digits.
fn card_ms(ms: Option<f64>) -> String {
    match ms {
        Some(ms) if ms.is_finite() && ms >= 0.0 => {
            if ms < 1000.0 {
                if ms < 10.0 {
                    format!("{ms:.1} ms")
                } else {
                    format!("{ms:.0} ms")
                }
            } else {
                format!("{:.2} s", ms / 1000.0)
            }
        }
        _ => "—".to_string(),
    }
}

fn card_speed(tokens: Option<f64>) -> String {
    match tokens {
        Some(tokens) if tokens.is_finite() && tokens > 0.0 => {
            if tokens >= 100.0 {
                format!("{tokens:.0} tok/s")
            } else {
                format!("{tokens:.1} tok/s")
            }
        }
        _ => "—".to_string(),
    }
}

fn card_count(value: Option<u32>) -> String {
    value.map_or_else(|| "—".to_string(), |n| n.to_string())
}

fn card_line(x: f64, y: f64, size: f64, fill: &str, weight: &str, spacing: f64, anchor: &str, text: &str) -> String {
    format!(
        r#"<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" letter-spacing="{spacing}" fill="{fill}" text-anchor="{anchor}">{text}</text>"#,
        font = CARD_FONT,
    )
}

/// Build the share card as SVG. Layout and typography live here so the page
/// only has to rasterise it; nothing is uploaded anywhere.
fn render_card_svg(card: &CardInput) -> String {
    let model = xml_escape(&clamp_chars(card.model.trim(), 30));
    let protocol = xml_escape(&clamp_chars(card.protocol.trim(), 18));
    let date = xml_escape(&clamp_chars(card.date.trim(), 24));
    let runs = if card.runs > 1 {
        format!("{} 次 · 时间取中位数", card.runs)
    } else {
        "单次测量".to_string()
    };
    let mut notes = Vec::new();
    if card.estimated {
        notes.push("输出 token 为估算");
    }
    if card.truncated {
        notes.push("输出被截断");
    }
    if card.window_short {
        notes.push("输出太短");
    }
    let meta = if notes.is_empty() {
        format!("{protocol} · {runs}")
    } else {
        format!("{protocol} · {runs} · {}", notes.join(" · "))
    };

    let mut svg = String::with_capacity(4096);
    svg.push_str(r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img">"##);
    svg.push_str(&format!(
        r##"<rect width="1200" height="630" fill="{CARD_PAPER}"/><rect x="28" y="28" width="1144" height="574" rx="24" fill="#ffffff" stroke="#e3eaf3"/>"##,
        CARD_PAPER = CARD_PAPER,
    ));
    svg.push_str(&format!(
        r##"<rect x="76" y="97" width="12" height="12" rx="3" fill="{CARD_INK}"/>"##,
        CARD_INK = CARD_INK,
    ));
    svg.push_str(&card_line(100.0, 109.0, 15.0, CARD_QUIET, "500", 3.5, "start", "TEST YOUR SPEED"));
    svg.push_str(&card_line(1124.0, 109.0, 15.0, CARD_QUIET, "400", 0.0, "end", &date));
    svg.push_str(&card_line(76.0, 202.0, 46.0, CARD_INK, "500", -0.5, "start", &model));
    svg.push_str(&card_line(76.0, 240.0, 18.0, CARD_QUIET, "400", 0.0, "start", &meta));
    svg.push_str(&format!(
        r##"<line x1="76" y1="282" x2="1124" y2="282" stroke="{CARD_RULE}"/>"##,
        CARD_RULE = CARD_RULE,
    ));

    svg.push_str(&card_line(76.0, 342.0, 16.0, CARD_QUIET, "400", 1.0, "start", "首 token"));
    svg.push_str(&card_line(76.0, 448.0, 104.0, CARD_INK, "500", -3.0, "start", &card_ms(card.ttft_ms)));

    let cells = [
        (660.0, 342.0, "响应时间", card_ms(card.total_ms)),
        (916.0, 342.0, "输出速度", card_speed(card.tokens_per_sec)),
        (660.0, 424.0, "整段速度", card_speed(card.e2e_tokens_per_sec)),
        (916.0, 424.0, "token 间隔", card_ms(card.itl_ms)),
    ];
    for (x, y, label, value) in cells {
        svg.push_str(&card_line(x, y, 16.0, CARD_QUIET, "400", 1.0, "start", label));
        svg.push_str(&card_line(x, y + 44.0, 36.0, CARD_INK, "500", -0.5, "start", &value));
    }

    svg.push_str(&format!(
        r##"<line x1="76" y1="496" x2="1124" y2="496" stroke="{CARD_RULE}"/>"##,
        CARD_RULE = CARD_RULE,
    ));

    let mut stats = vec![
        (76.0, "输入 token", card_count(card.prompt_tokens)),
        (500.0, "输出 token", card_count(card.completion_tokens)),
    ];
    if card.chars > 0 {
        stats.push((924.0, "输出字符", card.chars.to_string()));
    }
    for (x, label, value) in stats {
        let body = format!(
            r##"<tspan fill="{quiet}">{label}</tspan><tspan fill="{ink}" dx="12">{value}</tspan>"##,
            quiet = CARD_QUIET,
            ink = CARD_INK,
        );
        svg.push_str(&card_line(x, 552.0, 20.0, CARD_INK, "400", 0.0, "start", &body));
    }

    svg.push_str(&card_line(
        76.0,
        584.0,
        13.0,
        CARD_QUIET,
        "400",
        0.0,
        "start",
        "TestYourSpeed · on WASM",
    ));
    svg.push_str(&card_line(
        1124.0,
        584.0,
        13.0,
        CARD_QUIET,
        "400",
        0.0,
        "end",
        "github.com/Hill-1024/TestYourSpeed",
    ));
    svg.push_str("</svg>");
    svg
}

#[unsafe(no_mangle)]
pub extern "C" fn render_card(input_ptr: *const u8, input_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32 {
    let parsed = (|| {
        let bytes = read_bytes(input_ptr, input_len)?;
        serde_json::from_slice::<CardInput>(bytes).map_err(|_| "卡片数据无法解析".to_string())
    })();
    match parsed {
        Ok(card) => json_out(
            &CardJson {
                svg: render_card_svg(&card),
            },
            out_ptr,
            out_cap,
        ),
        Err(error) => set_error(error),
    }
}

fn feed_parts(carry: &[u8], chunk: &[u8], chunk_offset: usize) -> Result<(Vec<u8>, Vec<Event>), String> {
    if carry.len().saturating_add(chunk.len()) > MAX_INPUT {
        return Err(format!("输入超过 {MAX_INPUT} 字节"));
    }
    let base = chunk_offset.checked_sub(carry.len()).ok_or("分片偏移对不上")?;
    let mut combined = Vec::with_capacity(carry.len() + chunk.len());
    combined.extend_from_slice(carry);
    combined.extend_from_slice(chunk);
    Ok(drain(&combined, base))
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error(out_ptr: *mut u8, out_cap: usize) -> i32 {
    LAST_ERROR.with(|slot| {
        let message = slot.borrow();
        if message.len() > out_cap {
            return -1;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(message.as_ptr(), out_ptr, message.len());
        }
        message.len() as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn feed(
    carry_ptr: *const u8,
    carry_len: usize,
    chunk_ptr: *const u8,
    chunk_len: usize,
    chunk_offset: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    let parsed = (|| {
        let carry = read_bytes(carry_ptr, carry_len)?;
        let chunk = read_bytes(chunk_ptr, chunk_len)?;
        feed_parts(carry, chunk, chunk_offset)
    })();
    match parsed {
        Ok((carry, events)) => {
            let view = FeedJson {
                carry_b64: STANDARD.encode(carry),
                events: &events,
            };
            json_out(&view, out_ptr, out_cap)
        }
        Err(error) => set_error(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn finish(
    carry_ptr: *const u8,
    carry_len: usize,
    carry_offset: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    let parsed = (|| {
        let carry = read_bytes(carry_ptr, carry_len)?;
        let mut padded = carry.to_vec();
        if !padded.is_empty() {
            padded.extend_from_slice(b"\n\n");
        }
        Ok::<_, String>(drain(&padded, carry_offset))
    })();
    match parsed {
        Ok((_, events)) => json_out(&events, out_ptr, out_cap),
        Err(error) => set_error(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_unary(body_ptr: *const u8, body_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32 {
    let parsed = (|| {
        let body = read_bytes(body_ptr, body_len)?;
        serde_json::from_slice::<Value>(body).map_err(|_| "响应不是 JSON".to_string())
    })();
    match parsed {
        Ok(value) => json_out(&events_from_json(&value, 0), out_ptr, out_cap),
        Err(error) => set_error(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn summarize(spec_ptr: *const u8, spec_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32 {
    let parsed = (|| {
        let bytes = read_bytes(spec_ptr, spec_len)?;
        serde_json::from_slice::<Spec>(bytes).map_err(|_| "测速数据无法解析".to_string())
    })();
    match parsed {
        Ok(spec) => json_out(&summarize_spec(spec), out_ptr, out_cap),
        Err(error) => set_error(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aggregate(runs_ptr: *const u8, runs_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32 {
    let parsed = (|| {
        let bytes = read_bytes(runs_ptr, runs_len)?;
        serde_json::from_slice::<Vec<Report>>(bytes).map_err(|_| "多次测量的结果无法解析".to_string())
    })();
    match parsed {
        Ok(runs) => json_out(&aggregate_runs(runs), out_ptr, out_cap),
        Err(error) => set_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse(chunk: &str) -> (Vec<u8>, Vec<Event>) {
        feed_parts(&[], chunk.as_bytes(), 0).unwrap()
    }

    #[test]
    fn assembles_utf8_split_inside_a_line() {
        let mut first = br#"data: {"choices":[{"delta":{"content":""#.to_vec();
        first.extend_from_slice(&[0xe4, 0xbd]); // first two bytes of 你
        let (carry, events) = feed_parts(&[], &first, 0).unwrap();
        assert!(events.is_empty());
        let mut second = vec![0xa0]; // last byte
        second.extend_from_slice(br#""}}]}

"#);
        let (carry, events) = feed_parts(&carry, &second, first.len()).unwrap();
        assert!(carry.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].text, "你");
        assert_eq!(events[0].kind, "content");
    }

    #[test]
    fn reads_usage_and_done() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ab\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        let (carry, events) = sse(raw);
        assert!(carry.is_empty());
        assert_eq!(events[0].text, "ab");
        assert_eq!(events[1].kind, "usage");
        assert_eq!(events[1].completion_tokens, Some(2));
        assert_eq!(events[2].kind, "done");
    }

    #[test]
    fn accepts_crlf_frames() {
        let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"z\"}}]}\r\n\r\n";
        let (carry, events) = sse(raw);
        assert!(carry.is_empty());
        assert_eq!(events[0].text, "z");
    }

    #[test]
    fn output_speed_excludes_ttft() {
        let spec = Spec {
            t_headers_ms: 40.0,
            t_total_ms: 540.0,
            request_bytes: 100,
            response_bytes: 800,
            ticks: vec![
                Tick {
                    t_ms: 100.0,
                    kind: "content".into(),
                    text: "a".into(),
                    prompt_tokens: None,
                    completion_tokens: None,
                    finish_reason: None,
                },
                Tick {
                    t_ms: 500.0,
                    kind: "content".into(),
                    text: "b".into(),
                    prompt_tokens: None,
                    completion_tokens: None,
                    finish_reason: Some("stop".into()),
                },
                Tick {
                    t_ms: 530.0,
                    kind: "usage".into(),
                    text: String::new(),
                    prompt_tokens: Some(8),
                    completion_tokens: Some(41),
                    finish_reason: None,
                },
            ],
        };
        let report = summarize_spec(spec);
        assert!(report.ok);
        assert_eq!(report.ttft_ms, Some(100.0));
        // (41 - 1) / (500 - 100) seconds = 100 tok/s
        let speed = report.tokens_per_sec.unwrap();
        assert!((speed - 100.0).abs() < 0.01, "{speed}");
        assert!(!report.estimated);
        assert!(!report.window_short);
        assert_eq!(report.prompt_tokens, Some(8));
        let itl = report.itl_ms.unwrap();
        assert!((itl - 10.0).abs() < 0.01, "{itl}");
    }

    #[test]
    fn estimates_when_usage_is_missing() {
        let spec = Spec {
            t_headers_ms: 10.0,
            t_total_ms: 10.0,
            request_bytes: 1,
            response_bytes: 1,
            ticks: vec![Tick {
                t_ms: 10.0,
                kind: "content".into(),
                text: "你好".into(),
                prompt_tokens: None,
                completion_tokens: None,
                finish_reason: None,
            }],
        };
        let report = summarize_spec(spec);
        assert!(report.estimated);
        assert!(report.window_short);
        assert_eq!(report.completion_tokens, Some(2));
    }

    #[test]
    fn unary_message() {
        let raw = br#"{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        let value: Value = serde_json::from_slice(raw).unwrap();
        let events = events_from_json(&value, 0);
        assert_eq!(events[0].text, "pong");
        assert_eq!(events[1].completion_tokens, Some(1));
    }

    #[test]
    fn responses_delta_and_usage() {
        let raw = br#"{"type":"response.output_text.delta","delta":"pong"}"#;
        let events = events_from_json(&serde_json::from_slice::<Value>(raw).unwrap(), 0);
        assert_eq!(events[0].text, "pong");

        let done = br#"{"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":3,"output_tokens":1}}}"#;
        let events = events_from_json(&serde_json::from_slice::<Value>(done).unwrap(), 0);
        assert!(events.iter().all(|event| event.text.is_empty()));
        assert!(events.iter().any(|event| event.kind == "usage" && event.completion_tokens == Some(1)));
        assert!(events.iter().any(|event| event.prompt_tokens == Some(3)));

        let unary = br#"{"output":[{"content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":3,"output_tokens":1}}"#;
        let events = events_from_json(&serde_json::from_slice::<Value>(unary).unwrap(), 0);
        assert!(events.iter().any(|event| event.text == "pong"));
    }

    #[test]
    fn anthropic_delta_and_message() {
        let raw = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}"#.as_bytes();
        let events = events_from_json(&serde_json::from_slice::<Value>(raw).unwrap(), 0);
        assert_eq!(events[0].text, "你");

        let end = br#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8}}"#;
        let events = events_from_json(&serde_json::from_slice::<Value>(end).unwrap(), 0);
        assert!(events.iter().any(|event| event.finish_reason.as_deref() == Some("length")));
        assert!(events.iter().any(|event| event.completion_tokens == Some(8)));

        let unary = br#"{"content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":1}}"#;
        let events = events_from_json(&serde_json::from_slice::<Value>(unary).unwrap(), 0);
        assert!(events.iter().any(|event| event.text == "pong"));
        assert!(events.iter().any(|event| event.prompt_tokens == Some(2)));
    }

    #[test]
    fn marks_length_truncation() {
        let spec = Spec {
            t_headers_ms: 5.0,
            t_total_ms: 200.0,
            request_bytes: 1,
            response_bytes: 1,
            ticks: vec![
                Tick {
                    t_ms: 20.0,
                    kind: "content".into(),
                    text: "hi".into(),
                    prompt_tokens: None,
                    completion_tokens: None,
                    finish_reason: None,
                },
                Tick {
                    t_ms: 180.0,
                    kind: "content".into(),
                    text: "!!".into(),
                    prompt_tokens: None,
                    completion_tokens: None,
                    finish_reason: Some("length".into()),
                },
                Tick {
                    t_ms: 190.0,
                    kind: "usage".into(),
                    text: String::new(),
                    prompt_tokens: Some(1),
                    completion_tokens: Some(4),
                    finish_reason: None,
                },
            ],
        };
        let report = summarize_spec(spec);
        assert!(report.truncated);
        assert!(report.ok);
    }

    #[test]
    fn averages_tokens_across_runs() {
        let make = |tokens: u32| Report {
            ok: true,
            error: None,
            warning: None,
            ttft_ms: Some(100.0),
            total_ms: 500.0,
            ttfb_ms: 40.0,
            t_last_ms: Some(480.0),
            tokens_per_sec: Some(50.0),
            e2e_tokens_per_sec: Some(20.0),
            itl_ms: Some(20.0),
            prompt_tokens: Some(10),
            completion_tokens: Some(tokens),
            estimated: false,
            truncated: false,
            window_short: false,
            request_bytes: 10,
            response_bytes: 100,
            chars: 20,
        };
        let summary = aggregate_runs(vec![make(10), make(21)]);
        assert!(summary.ok);
        assert_eq!(summary.prompt_tokens, Some(10));
        assert_eq!(summary.completion_tokens, Some(16)); // (10 + 21) / 2 = 15.5 -> 16
    }

    fn card() -> CardInput {
        CardInput {
            model: "gpt-5-mini".into(),
            protocol: "Chat Completions".into(),
            runs: 3,
            date: "2026-10-28".into(),
            ttft_ms: Some(842.4),
            total_ms: Some(3020.0),
            tokens_per_sec: Some(84.2),
            e2e_tokens_per_sec: Some(31.4),
            itl_ms: Some(11.9),
            prompt_tokens: Some(24),
            completion_tokens: Some(312),
            chars: 1280,
            estimated: false,
            truncated: false,
            window_short: false,
        }
    }

    #[test]
    fn card_lays_out_the_metrics() {
        let svg = render_card_svg(&card());
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("gpt-5-mini"));
        assert!(svg.contains("3 次 · 时间取中位数"));
        assert!(svg.contains(">842 ms<"));
        assert!(svg.contains(">3.02 s<"));
        assert!(svg.contains(">84.2 tok/s<"));
        assert!(svg.contains(">312<"));
    }

    #[test]
    fn card_escapes_text_and_marks_estimates() {
        let mut input = card();
        input.model = "a<b>&\"c".into();
        input.estimated = true;
        input.truncated = true;
        input.chars = 0;
        input.prompt_tokens = None;
        let svg = render_card_svg(&input);
        assert!(svg.contains("a&lt;b&gt;&amp;&quot;c"));
        assert!(!svg.contains("a<b>"));
        assert!(svg.contains("输出 token 为估算 · 输出被截断"));
        assert!(svg.contains(">—<"));
        assert!(!svg.contains("输出字符"));
    }

    #[test]
    fn card_truncates_long_model_names() {
        let mut input = card();
        input.model = "x".repeat(40);
        let svg = render_card_svg(&input);
        assert!(svg.contains(&format!("{}…", "x".repeat(29))));
        assert!(!svg.contains(&"x".repeat(31)));
    }
}
