import { assertEquals, assertStringIncludes } from "@std/assert";
import { getDoc, listTopics } from "./index.ts";

// --- Handler ABI in the platform docs ------------------------------------------
// `get_platform_docs({ topic: "compilation" })` serves this file verbatim, so it
// is the OPEN-layer companion to the define_handler description: an agent that
// reads the docs instead of the tool schema has to land on the same ABI. The
// assertions are on the CHECKED-IN generated file, which is what ships — if
// core/docs/generate.ts is edited without re-running `deno task docs:generate`,
// this is what notices.

Deno.test("the compilation doc teaches the framework-free handler ABI", () => {
  const doc = getDoc("compilation");
  assertEquals(doc !== undefined, true);
  const content = doc?.content ?? "";
  // `deno fmt` reflows the generated markdown, so prose assertions run against a
  // whitespace-collapsed copy; only the fenced code block keeps its line breaks.
  const prose = content.replace(/\s+/g, " ");

  assertStringIncludes(content, "## Handler ABI");
  assertStringIncludes(
    content,
    "async function getTodo(req: Request, ctx: HandlerContext)",
  );
  assertStringIncludes(content, "ctx.params.id");
  assertStringIncludes(content, "await req.json()");
  assertStringIncludes(content, "Response.json(data, { status: 201 })");
  // The two claims the stage exists to make: routing is the kernel's whole job,
  // and a library you install is still fair game — mounted, not assumed.
  assertStringIncludes(prose, "the kernel owns routing and nothing else");
  assertStringIncludes(content, "install_package");
  assertStringIncludes(content, "return app.fetch(req)");
  // And the back-compat promise, which is true (core/handler-abi.ts) and worth
  // stating so an agent reading an old handler does not "fix" it.
  assertStringIncludes(prose, "keep running unchanged");
});

Deno.test("no platform doc still describes the handler argument as a framework context", () => {
  for (const topic of listTopics()) {
    const content = getDoc(topic)?.content ?? "";
    assertEquals(
      /Hono|hono/.test(content),
      false,
      `platform doc "${topic}" still mentions Hono`,
    );
  }
});
