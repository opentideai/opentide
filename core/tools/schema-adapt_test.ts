import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { CUSTOM_TOOLS, type CustomToolDef } from "./definitions.ts";
import {
  type OpenAIFunctionTool,
  toNeutralTool,
  toNeutralTools,
  toOpenAIFunctionTool,
  toOpenAIFunctionTools,
} from "./schema-adapt.ts";

// Look a real tool def up by name so the tests exercise the actual shipped
// schemas, not a hand-rolled fixture that could drift from definitions.ts.
function toolByName(name: string): CustomToolDef {
  const def = CUSTOM_TOOLS.find((t) => t.name === name);
  assert(def !== undefined, `expected a CUSTOM_TOOLS entry named "${name}"`);
  return def;
}

// A varied sample: a no-arg tool, a required-string-param tool, and a tool with
// nested object properties.
const NO_ARG_TOOL = "list_routes";
const REQUIRED_STRING_TOOL = "get_handler_source";
const NESTED_TOOL = "register_route";

Deno.test("toNeutralTool copies name/description and the schema body verbatim", () => {
  for (const name of [NO_ARG_TOOL, REQUIRED_STRING_TOOL, NESTED_TOOL]) {
    const def = toolByName(name);
    const neutral = toNeutralTool(def);

    assertEquals(neutral.name, def.name);
    assertEquals(neutral.description, def.description);
    // Deep-equal: the JSON Schema body transfers unchanged.
    assertEquals(neutral.inputSchema, def.input_schema);
  }
});

Deno.test("toNeutralTool shares the schema reference (verbatim, not a copy)", () => {
  // The adapter deliberately hands back the same object (Stage 0: the body
  // transfers verbatim). Assert the intended shared reference so a future
  // accidental deep-copy is caught.
  const def = toolByName(NESTED_TOOL);
  assertStrictEquals(toNeutralTool(def).inputSchema, def.input_schema);
});

Deno.test("toOpenAIFunctionTool yields the OpenAI function shape with the schema as parameters", () => {
  for (const name of [NO_ARG_TOOL, REQUIRED_STRING_TOOL, NESTED_TOOL]) {
    const def = toolByName(name);
    const tool = toOpenAIFunctionTool(def);

    const expected: OpenAIFunctionTool = {
      type: "function",
      function: {
        name: def.name,
        description: def.description,
        parameters: def.input_schema,
      },
    };
    assertEquals(tool, expected);
    assertEquals(tool.type, "function");
    assertEquals(tool.function.parameters, def.input_schema);
    // Same intentional shared reference as the neutral path.
    assertStrictEquals(tool.function.parameters, def.input_schema);
  }
});

Deno.test("full-set sweep: both adapters preserve name + schema for every CUSTOM_TOOL", () => {
  const neutral = toNeutralTools(CUSTOM_TOOLS);
  const openai = toOpenAIFunctionTools(CUSTOM_TOOLS);

  assertEquals(neutral.length, CUSTOM_TOOLS.length);
  assertEquals(openai.length, CUSTOM_TOOLS.length);

  CUSTOM_TOOLS.forEach((def, i) => {
    const n = neutral[i];
    const o = openai[i];
    assert(n !== undefined && o !== undefined);

    assertEquals(n.name, def.name);
    assertEquals(n.inputSchema, def.input_schema);

    assertEquals(o.type, "function");
    assertEquals(o.function.name, def.name);
    assertEquals(o.function.parameters, def.input_schema);
  });
});
