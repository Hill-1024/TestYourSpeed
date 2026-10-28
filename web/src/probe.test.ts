import { describe, expect, it } from "vitest";
import { adaptPayload, httpError, modelIds, modelsUrl, requestBody, requestUrl, type ProbeRequest } from "./probe";

const req: ProbeRequest = {
  api: "chat",
  endpoint: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-test",
  prompt: "hi",
  maxTokens: 128,
  temperature: 0,
};

describe("requestUrl", () => {
  it("appends the protocol path to a base", () => {
    expect(requestUrl("chat", "https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(requestUrl("responses", "https://api.example.com/v1")).toBe("https://api.example.com/v1/responses");
    expect(requestUrl("anthropic", "https://api.example.com")).toBe("https://api.example.com/messages");
  });

  it("keeps a complete path as typed", () => {
    expect(requestUrl("chat", "https://api.example.com/v1/messages")).toBe("https://api.example.com/v1/messages");
    expect(requestUrl("anthropic", "https://api.example.com/v1/messages/")).toBe("https://api.example.com/v1/messages/");
  });

  it("keeps the query string", () => {
    expect(requestUrl("chat", "https://api.example.com/v1?api-version=1")).toBe(
      "https://api.example.com/v1/chat/completions?api-version=1",
    );
  });

  it("rejects an empty or relative endpoint", () => {
    expect(() => requestUrl("chat", "  ")).toThrow(/接口地址/);
    expect(() => requestUrl("chat", "not a url")).toThrow(/完整的 URL/);
  });
});

describe("requestBody", () => {
  it("uses max_tokens and temperature by default", () => {
    const body = requestBody(req);
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("switches to max_completion_tokens when asked", () => {
    const body = requestBody(req, { temperature: false, maxTokensField: "max_completion_tokens" });
    expect(body.max_completion_tokens).toBe(128);
    expect(body.max_tokens).toBeUndefined();
    expect("temperature" in body).toBe(false);
  });

  it("keeps max_output_tokens for Responses and max_tokens for Messages", () => {
    const responses = requestBody({ ...req, api: "responses" });
    expect(responses.max_output_tokens).toBe(128);
    expect(responses.messages).toBeUndefined();
    const anthropic = requestBody({ ...req, api: "anthropic" });
    expect(anthropic.max_tokens).toBe(128);
    expect(anthropic.max_output_tokens).toBeUndefined();
  });
});

describe("adaptPayload", () => {
  it("switches to max_completion_tokens for newer OpenAI models", () => {
    const detail =
      '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}';
    const retry = adaptPayload({ temperature: true, maxTokensField: "max_tokens" }, detail, "chat");
    expect(retry?.options.maxTokensField).toBe("max_completion_tokens");
  });

  it("drops temperature when the model refuses it", () => {
    const detail = '{"error":{"message":"Unsupported parameter: \'temperature\' is not supported with this model."}}';
    const retry = adaptPayload({ temperature: true, maxTokensField: "max_tokens" }, detail, "responses");
    expect(retry?.options.temperature).toBe(false);
    expect(retry?.options.maxTokensField).toBe("max_tokens");
  });

  it("leaves unrelated 400s alone", () => {
    expect(adaptPayload({ temperature: true, maxTokensField: "max_tokens" }, "invalid api key", "chat")).toBeNull();
    expect(
      adaptPayload({ temperature: true, maxTokensField: "max_tokens" }, "temperature must be between 0 and 2", "chat"),
    ).toBeNull();
  });
});

describe("modelIds", () => {
  it("reads OpenAI and Anthropic shapes", () => {
    expect(modelIds({ data: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "  " }] })).toEqual(["a", "b"]);
    expect(modelIds([{ id: "c" }, "d"])).toEqual(["c", "d"]);
    expect(modelIds({ nope: true })).toEqual([]);
  });
});

describe("modelsUrl", () => {
  it("goes to /models beside the chat path", () => {
    expect(modelsUrl("https://x.dev/v1", "")).toBe("https://x.dev/v1/models");
    expect(modelsUrl("https://x.dev/v1/chat/completions", "")).toBe("https://x.dev/models");
    expect(modelsUrl("https://x.dev/v1", "https://x.dev/custom/models")).toBe("https://x.dev/custom/models");
  });
});

describe("httpError", () => {
  it("explains the common failures", () => {
    expect(httpError(401, "")).toMatch(/密钥被拒绝/);
    expect(httpError(404, "")).toMatch(/404/);
    expect(httpError(500, "boom")).toBe("接口返回 500：boom");
  });
});
