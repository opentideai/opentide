// @layer core — the mechanical tool-schema adapter (multi-model harness,
// docs/multi-model-harness-plan.md §4 "The seam", Stage 2 Slice 1).
//
// Maps our CustomToolDef (core/tools/definitions.ts) onto the two shapes a
// provider needs: the NeutralTool contract (core/model-provider.ts, driven by
// the AI-SDK-backed impl) and the OpenAI function-tool shape. Stage 0 proved the
// JSON Schema body transfers VERBATIM in both directions (spike/FINDINGS.md §4
// items 1 & 2), so these are tiny, pure, total mappings over a well-formed
// CustomToolDef — no I/O, no throwing, no deep rewrite of the schema body.
//
// LANDS DARK: nothing imports this yet — wired into the loop in Stage 3.

import type { CustomToolDef } from "./definitions.ts";
import type { NeutralTool } from "../model-provider.ts";

// The OpenAI function-tool shape. Defined locally (no SDK dependency): `type` is
// the literal "function" tag, and `parameters` is the raw JSON Schema body —
// the same Record<string, unknown> as CustomToolDef.input_schema, not a new
// schema type.
export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const OPENAI_FUNCTION_TOOL_TYPE = "function" as const;

// CustomToolDef → NeutralTool. `inputSchema` is `input_schema` unchanged (same
// object reference — Stage 0 proved the body transfers verbatim, so we do not
// copy it).
export function toNeutralTool(def: CustomToolDef): NeutralTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema,
  };
}

// CustomToolDef → OpenAI function tool. `parameters` is `input_schema` unchanged
// (same object reference, verbatim body).
export function toOpenAIFunctionTool(def: CustomToolDef): OpenAIFunctionTool {
  return {
    type: OPENAI_FUNCTION_TOOL_TYPE,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.input_schema,
    },
  };
}

// Batch helpers to keep call sites DRY.
export function toNeutralTools(defs: readonly CustomToolDef[]): NeutralTool[] {
  return defs.map(toNeutralTool);
}

export function toOpenAIFunctionTools(
  defs: readonly CustomToolDef[],
): OpenAIFunctionTool[] {
  return defs.map(toOpenAIFunctionTool);
}
