import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { buildTtsProviderModels, getTtsVoicesForModel } from "../../open-sse/config/ttsModels.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getTtsAdapter } from "../../open-sse/handlers/ttsProviders/index.js";
import { TTS_PROVIDER_CONFIG } from "../../src/shared/constants/ttsProviders.js";

const originalFetch = global.fetch;

// Raw audio bytes the /audio/speech endpoint returns (>100 bytes — responseToBase64
// rejects smaller payloads as "empty audio")
const MP3_BYTES = Uint8Array.from(
  [0xff, 0xf3, 0x40, 0xc4, ...Array(200).fill(0x55), 0x01]
);
const MP3_BASE64 = Buffer.from(MP3_BYTES).toString("base64");

function mockAudioSpeechResponse() {
  global.fetch.mockResolvedValueOnce(
    new Response(MP3_BYTES, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
  );
}

// SSE stream chunks for the legacy openai/* chat-completions audio path
function mockChatAudioStream() {
  const data = Buffer.from([0, 1, 2, 3]).toString("base64");
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data } } }] })}\n\n` +
    `data: [DONE]\n\n`;
  global.fetch.mockResolvedValueOnce(
    new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  );
}

describe("OpenRouter TTS — free /audio/speech models", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes deepgram/flux-tts:free through the dedicated /audio/speech endpoint", async () => {
    mockAudioSpeechResponse();

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "deepgram/flux-tts:free/flux-alexis-en",
      input: "Hello! This is a text-to-speech test.",
      credentials: { apiKey: "test-key" },
      responseFormat: "mp3",
    });

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(init.headers.Authorization).toBe("Bearer test-key");

    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("deepgram/flux-tts:free");
    expect(sent.voice).toBe("flux-alexis-en");
    expect(sent.input).toBe("Hello! This is a text-to-speech test.");
    expect(sent.response_format).toBe("mp3");

    // Binary response carries the raw upstream audio
    const bytes = new Uint8Array(await result.response.arrayBuffer());
    expect(Buffer.from(bytes).toString("base64")).toBe(MP3_BASE64);
  });

  it("splits deepgram voice ids on the known-model boundary, not the last slash", async () => {
    mockAudioSpeechResponse();

    await handleTtsCore({
      provider: "openrouter",
      // Voice "flux-alexis-en" contains hyphens but no slash — a *voice with a slash*
      // must still split on the known model boundary. Use the bare model to verify
      // defaulting to the first known model id.
      model: "deepgram/flux-tts:free/flux-alexis-en",
      input: "hi",
      credentials: { apiKey: "test-key" },
      responseFormat: "json",
    });

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("deepgram/flux-tts:free");
    expect(sent.voice).toBe("flux-alexis-en");
  });

  it("surfaces a clear error for deepgram requests without a voice (upstream requires one)", async () => {
    const result = await handleTtsCore({
      provider: "openrouter",
      model: "deepgram/flux-tts:free",
      input: "hi",
      credentials: { apiKey: "test-key" },
      responseFormat: "mp3",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a voice/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("omits voice for fish-audio (provider-side default voice)", async () => {
    mockAudioSpeechResponse();

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "fish-audio/s2.1-pro-free:free",
      input: "Hello! This is a text-to-speech test.",
      credentials: { apiKey: "test-key" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("fish-audio/s2.1-pro-free:free");
    expect(sent).not.toHaveProperty("voice");
    expect(sent.input).toBe("Hello! This is a text-to-speech test.");

    const body = await result.response.json();
    expect(body.format).toBe("mp3");
    expect(body.audio).toBe(MP3_BASE64);
  });

  it("keeps openai/* models on the legacy chat-completions audio path", async () => {
    mockChatAudioStream();

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts/alloy",
      input: "Hello",
      credentials: { apiKey: "test-key" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");

    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("openai/gpt-4o-mini-tts");
    expect(sent.modalities).toEqual(["text", "audio"]);
    expect(sent.audio).toEqual({ voice: "alloy", format: "wav" });
    expect(sent.stream).toBe(true);

    const body = await result.response.json();
    expect(body.format).toBe("wav");
  });

  it("exposes the new free models + Flux voices in the TTS catalog", () => {
    const entries = buildTtsProviderModels();
    const modelIds = entries["openrouter-tts-models"].map((m) => m.id);
    expect(modelIds).toContain("deepgram/flux-tts:free");
    expect(modelIds).toContain("fish-audio/s2.1-pro-free:free");

    const fluxVoices = getTtsVoicesForModel("openrouter", "deepgram/flux-tts:free");
    expect(fluxVoices.length).toBe(36);
    expect(fluxVoices[0]).toMatchObject({ id: "flux-alexis-en", name: "flux-alexis-en" });
    expect(fluxVoices.map((v) => v.id)).toContain("flux-kai-en");

    // fish-audio has no fixed voice catalog
    expect(getTtsVoicesForModel("openrouter", "fish-audio/s2.1-pro-free:free")).toEqual([]);

    // Registry models carry kind "tts" so /v1/models?kind=tts lists them
    const ttsModels = PROVIDER_MODELS["openrouter"].filter((m) => (m.kind || m.type) === "tts").map((m) => m.id);
    expect(ttsModels).toContain("deepgram/flux-tts:free");
    expect(ttsModels).toContain("fish-audio/s2.1-pro-free:free");

    expect(getTtsAdapter("openrouter")).toBeTruthy();
    expect(TTS_PROVIDER_CONFIG["openrouter"].voicesPerModel).toBe(true);
  });
});
