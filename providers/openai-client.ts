// @layer providers — the one place the OpenAI AI-SDK client is constructed. Both
// OpenAI call sites (the streaming provider's resolveModel and the one-shot utility
// call) route through here so the configurable base URL (getOpenaiBaseUrl) is threaded
// in exactly once, and so providers/ owns the single `createOpenAI` seam.
//
// LAYER: open L2, sibling of openai-provider.ts / utility-provider.ts. It imports core
// (down — the base-URL accessor) and the Vercel AI SDK. It must NEVER import
// agent-loop/ or agent/ — the loop stays SDK-free.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  type ModelProviderId,
  openAiCompatibleBaseUrlFor,
} from "../core/config.ts";

// Build the SDK LanguageModel for an OpenAI(-compatible) request. The base URL is
// passed ONLY when configured, so an install that never sets one is byte-identical to
// before this seam existed (the SDK's own api.openai.com default). The apiKey is passed
// only when present; a keyless local endpoint works by entering any non-empty string as
// the key upstream, which keeps the discovery gate and status row unchanged.
export function openAiModelFor(
  modelId: string,
  apiKey: string | undefined,
  providerId: ModelProviderId = "openai",
): LanguageModel {
  const baseURL = openAiCompatibleBaseUrlFor(providerId);
  const provider = createOpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
  return providerId === "openai" ? provider(modelId) : provider.chat(modelId);
}
