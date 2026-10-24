import { assert, assertEquals } from "@std/assert";
import { composePrompt, formatResidentDocuments } from "./prompt-compose.ts";

Deno.test("formatResidentDocuments returns empty for no resident docs", () => {
  assertEquals(formatResidentDocuments(), "");
  assertEquals(formatResidentDocuments([]), "");
});

Deno.test("formatResidentDocuments frames each doc as source under the heading", () => {
  const section = formatResidentDocuments([
    {
      name: "Migration plan",
      versionHash: "abc123",
      content: "# Plan\nStep one.",
    },
  ]);
  assert(section.includes("## Resident documents"));
  assert(section.includes("### Migration plan"));
  assert(section.includes('version="abc123"'));
  // The source is fed verbatim (not rendered — §12).
  assert(section.includes("# Plan\nStep one."));
});

Deno.test("composePrompt appends the resident-documents section after other sections", () => {
  const prompt = composePrompt("BASE", {
    customInstructions: "be terse",
    residentDocuments: [
      { name: "Spec", versionHash: "v1", content: "the spec body" },
    ],
  });
  assert(prompt.startsWith("BASE"));
  assert(prompt.includes("## Custom Instructions"));
  assert(prompt.includes("## Resident documents"));
  assert(prompt.includes("the spec body"));
  // Resident docs come last, after custom instructions.
  assert(
    prompt.indexOf("## Resident documents") >
      prompt.indexOf("## Custom Instructions"),
  );
});

Deno.test("composePrompt omits the section when there are no resident docs", () => {
  const prompt = composePrompt("BASE", {
    skills: [{ name: "s", prompt: "p" }],
  });
  assert(!prompt.includes("## Resident documents"));
});
