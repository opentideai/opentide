// The loop side of index_codebase "assist": the server leaves the
// classification owed, and the loop runs it on the brain's reviewer before the
// model sees the result. Stub reviewers: no model.
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import { testComposition } from "../cli/test-composition.ts";
import type { Reviewer } from "../core/chat-intelligence.ts";
import { IMPORT_CLASSIFIER_PLUGIN_ID } from "../core/codebase/index.ts";
import {
  inProcessChangesetClient,
  inProcessToolTransport,
} from "./chat-backend.ts";
import { callWithReviews } from "./reviews.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function indexWith(
  reviewer: Reviewer,
): Promise<{ classification: { status: string }; kernel: Kernel }> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const root = await Deno.makeTempDir({ prefix: "genie-loop-imports-" });
  try {
    await Deno.writeTextFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "^5.0.0" } }),
    );
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(
      join(root, "src", "index.ts"),
      "export const a = 1;",
    );
    const result = await callWithReviews(
      {
        tools: inProcessToolTransport(kernel, () => {}),
        changesets: inProcessChangesetClient(kernel),
        reviewer,
        context: {},
      },
      "index_codebase",
      { rootPath: root, classification: "assist" },
    );
    assert(result.ok, JSON.stringify(result.error));
    const data = result.data as { classification: { status: string } };
    return { classification: data.classification, kernel };
  } finally {
    await Deno.remove(root, { recursive: true });
    await db.close();
  }
}

Deno.test({
  ...testOpts,
  name: "index_codebase assist: the loop classifies and the graph takes it",
  fn: async () => {
    const { classification, kernel } = await indexWith({
      review: (packet) =>
        Promise.resolve(
          packet.kind === "imports"
            ? {
              status: "ok",
              reviewer: "stub",
              verdict: {
                facts: [{
                  kind: "framework",
                  name: "express",
                  value: "express",
                  confidence: 0.9,
                }],
                mappings: [],
                diagnostics: [],
                candidateEntities: [],
              },
            }
            : { status: "failed", message: "unexpected packet" },
        ),
    });
    assertEquals(classification.status, "completed");
    assert(
      kernel.codebaseGraph!.plugins.some((p) =>
        p.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID && p.status === "completed"
      ),
    );
  },
});

Deno.test({
  ...testOpts,
  name:
    "index_codebase assist: no import model reads as skipped, the index stands",
  fn: async () => {
    const { classification, kernel } = await indexWith({
      review: () =>
        Promise.resolve({
          status: "unavailable",
          code: "MODEL_UNCONFIGURED",
          message: "No model is configured for this role.",
        }),
    });
    assertEquals(classification.status, "skipped_unconfigured");
    assertEquals(kernel.codebaseGraph!.files.length, 1);
  },
});
