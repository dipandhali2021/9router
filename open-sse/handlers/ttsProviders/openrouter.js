// OpenRouter TTS — two upstream protocols:
//  - openai/* TTS models (gpt-4o-mini-tts, tts-1, tts-1-hd): chat completions + audio modality (SSE stream)
//  - native TTS models (deepgram/flux-tts:free, fish-audio/s2.1-pro-free:free): dedicated
//    /api/v1/audio/speech endpoint returning raw audio bytes
//    https://openrouter.ai/docs/guides/overview/multimodal/tts
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../providers/index.js";
import { parseModelVoice, responseToBase64, throwUpstreamError } from "./_base.js";

const TTS_CFG = PROVIDER_MEDIA["openrouter"]?.ttsConfig || {};

// Model id prefixes served by the dedicated /audio/speech endpoint.
// Everything else keeps the legacy chat-completions audio-modality path.
const AUDIO_SPEECH_MODEL_PREFIXES = ["deepgram/", "fish-audio/"];

// Known openrouter TTS model ids (single source: registry models with kind "tts")
// for "modelId/voiceId" splitting.
const KNOWN_TTS_MODELS = (PROVIDER_MODELS["openrouter"] || []).filter(
  (m) => (m.kind || m.type) === "tts"
);

export default {
  async synthesize(text, model, credentials, responseFormat = "mp3") {
    if (!credentials?.apiKey) throw new Error("No OpenRouter API key configured");

    // model arrives as "modelId/voiceId" (provider prefix already stripped by
    // parseModel), e.g. "deepgram/flux-tts:free/flux-alexis-en". Known-model
    // matching wins so voice ids containing "/" can never split the model id.
    const { modelId, voiceId } = parseModelVoice(model || "", TTS_CFG.defaultModel, "", KNOWN_TTS_MODELS);

    if (AUDIO_SPEECH_MODEL_PREFIXES.some((p) => modelId.startsWith(p))) {
      return synthesizeViaAudioSpeech(text, modelId, voiceId, credentials, responseFormat);
    }

    // ── Legacy path: chat completions + audio modality (openai/* TTS models) ──
    const res = await fetch(TTS_CFG.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${credentials.apiKey}`,
        ...(TTS_CFG.headers || {}),
      },
      body: JSON.stringify({
        model: modelId,
        modalities: ["text", "audio"],
        audio: { voice: voiceId || "alloy", format: "wav" },
        stream: true,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenRouter TTS failed: ${res.status}`);
    }

    // Parse SSE stream, accumulate base64 audio chunks
    const chunks = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const json = JSON.parse(line.slice(6));
          const audioData = json.choices?.[0]?.delta?.audio?.data;
          if (audioData) chunks.push(audioData);
        } catch {}
      }
    }

    if (chunks.length === 0) throw new Error("OpenRouter TTS returned no audio data");
    return { base64: chunks.join(""), format: "wav" };
  },
};

// ── Dedicated /audio/speech path (deepgram, fish-audio, ...) ────────────────
async function synthesizeViaAudioSpeech(text, modelId, voiceId, credentials, responseFormat) {
  // OpenRouter audio/speech output formats: mp3 | pcm (default pcm). The route's
  // responseFormat is "mp3" (binary) or "json" (base64 wrapper) — always request mp3 there.
  const upstreamFormat = responseFormat === "pcm" ? "pcm" : "mp3";

  // voice is required for models with a fixed catalog and must be omitted for
  // models without one (fish-audio uses its provider-side default voice).
  const body = { model: modelId, input: text, response_format: upstreamFormat };
  if (voiceId) {
    body.voice = voiceId;
  } else if (modelId.startsWith("deepgram/")) {
    throw new Error(`deepgram/flux-tts:free requires a voice — e.g. flux-alexis-en (see the voice list on the model page)`);
  }

  const res = await fetch(TTS_CFG.audioSpeechUrl || "https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.apiKey}`,
      ...(TTS_CFG.headers || {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) await throwUpstreamError(res);
  return responseToBase64(res, upstreamFormat);
}
