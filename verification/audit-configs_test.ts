// @layer verification — gates on the audit prompt text.
//
// These prompts are the only thing standing between the auditors and a wave of
// false positives on the fetch ABI. They are prose, so nothing type-checks them
// and nothing catches drift; if someone re-adds a framework's handler contract
// here, the auditors quietly start flagging correct code as a smell. Hence a
// lint sweep with named bans rather than a review checklist.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { BUILTIN_AUDIT_CONFIGS } from "./audit-configs.ts";

/**
 * Framework-context teaching, spelled out. Each entry is something an auditor
 * would have to be told before it could flag a fetch-style handler for not
 * being one.
 */
const BANNED = [
  "Hono",
  "hono",
  "c.req.",
  "c.json(",
  "c.text(",
  "c.html(",
  "c.stream(",
  "Framework:",
] as const;

Deno.test("no audit prompt teaches a web framework's handler contract", () => {
  for (const [category, config] of Object.entries(BUILTIN_AUDIT_CONFIGS)) {
    for (const banned of BANNED) {
      assertEquals(
        config.systemPrompt.includes(banned),
        false,
        `the ${category} audit prompt still mentions ${banned}`,
      );
    }
  }
});

Deno.test("the security audit knows where untrusted input enters a fetch handler", () => {
  const prompt = BUILTIN_AUDIT_CONFIGS.security?.systemPrompt ?? "";
  // An auditor that can't name the input surfaces can't trace taint to them.
  for (
    const surface of [
      "await req.json()",
      "new URL(req.url).searchParams",
      "req.headers.get(name)",
      "ctx.params",
    ]
  ) {
    assertStringIncludes(prompt, surface);
  }
  // And it has to treat the legacy shape as a trust boundary too, not skip it.
  assertStringIncludes(prompt, "both are trust boundaries");
});

Deno.test("the security audit's IDOR example uses the fetch ABI", () => {
  const prompt = BUILTIN_AUDIT_CONFIGS.security?.systemPrompt ?? "";
  assertStringIncludes(prompt, "[ctx.params.id])");
});

Deno.test("the code-quality audit will not flag platform idioms as smells", () => {
  const prompt = BUILTIN_AUDIT_CONFIGS["code-quality"]?.systemPrompt ?? "";
  assertStringIncludes(prompt, "**Platform idioms**");
  for (
    const idiom of [
      "await req.json()",
      "new URL(req.url).searchParams",
      "ctx.params.id",
      "Response.json(data)",
    ]
  ) {
    assertStringIncludes(prompt, idiom);
  }
});

// The regression this whole stage exists to prevent. Every handler in every
// project that predates the fetch ABI is a legacy-context handler; the kernel
// shims them and they work. If the code-quality auditor stops being told that,
// it reports each one as a defect and every existing project audits dirty.
Deno.test("the code-quality audit will not flag legacy-context handlers", () => {
  const prompt = BUILTIN_AUDIT_CONFIGS["code-quality"]?.systemPrompt ?? "";
  assertStringIncludes(prompt, "**Legacy handler shape**");
  assertStringIncludes(
    prompt,
    "fully supported by the kernel and is NOT a defect",
  );
  assertStringIncludes(prompt, "never suggest migrating it");
});

Deno.test("CORS guidance still attributes the global policy to something real", () => {
  const prompt = BUILTIN_AUDIT_CONFIGS.security?.systemPrompt ?? "";
  assertStringIncludes(
    prompt,
    "enabled globally by the kernel gateway by design",
  );
});
