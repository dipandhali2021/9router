// Video provider adapter registry.
//
// A video adapter is OPTIONAL. Providers without one (xAI Grok Imagine) keep the
// byte-for-byte proxy in videoCore.js: the client's body goes upstream untouched
// and the upstream JSON comes back verbatim.
//
// Two adapter shapes coexist:
// - Request/response adapters (qwen, fal-ai, replicate) supply create/poll URLs,
//   headers and body via createUrl/pollUrl/buildHeaders/buildBody, and normalize
//   both responses into the `{request_id}` / `{status, video:{url}}` contract.
//   Those declaring `awaitCompletion` have their render waited out server-side.
// - Plan adapters (openrouter, vertex) implement `buildRequest()` returning a
//   {method, url, headers, body, error?} plan, and may map a provider-native
//   response shape with `transformResponse`.
import qwen from "./qwen.js";
import falAi from "./falAi.js";
import replicate from "./replicate.js";
import openrouter from "./openrouter.js";
import vertex from "./vertex.js";

const ADAPTERS = {
  qwen,
  "fal-ai": falAi,
  replicate,
  openrouter,
  vertex,
};

export function getVideoAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isVideoAdapterProvider(provider) {
  return provider in ADAPTERS;
}
