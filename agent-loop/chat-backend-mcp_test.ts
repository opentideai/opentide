import { assertEquals } from "@std/assert";
import { toToolResult } from "./chat-backend-mcp.ts";

const text = (t: string) => ({ type: "text", text: t });

Deno.test("toToolResult: an error keeps its code, message and suggestion", () => {
  assertEquals(
    toToolResult({
      isError: true,
      content: [
        text(
          "Error [NO_CHANGESET]: No active changeset.\nSee list_changesets.\nSuggestion: Create one.",
        ),
      ],
    }),
    {
      ok: false,
      error: {
        code: "NO_CHANGESET",
        message: "No active changeset.\nSee list_changesets.",
        suggestion: "Create one.",
      },
    },
  );
  assertEquals(
    toToolResult({ isError: true, content: [text("Tool failed.")] }),
    { ok: false, error: { code: "MCP_ERROR", message: "Tool failed." } },
  );
});

Deno.test("toToolResult: data skips leading notes and the trailing changes block", () => {
  assertEquals(
    toToolResult({
      content: [
        text("Changeset created, auto-approved."),
        text(JSON.stringify({ id: "cs_1", status: "in_progress" })),
        text(JSON.stringify({ changes: [{ id: 1 }], changesets: [] })),
      ],
    }),
    { ok: true, data: { id: "cs_1", status: "in_progress" } },
  );
});

Deno.test("toToolResult: images come back as PNG bytes", () => {
  const result = toToolResult({
    content: [text("null"), {
      type: "image",
      data: "AQID",
      mimeType: "image/png",
    }],
  });
  assertEquals(result.data, null);
  assertEquals(result._images?.[0]?.png, new Uint8Array([1, 2, 3]));
});
