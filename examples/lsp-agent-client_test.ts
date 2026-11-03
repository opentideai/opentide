import { assert, assertEquals } from "@std/assert";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { LSP_SURFACE_VERSION } from "../core/config.ts";
import { testComposition } from "../cli/test-composition.ts";
import { LspServer } from "../lsp/server.ts";
import { serveLspStdio } from "../lsp/transport.ts";
import {
  DEMO_ENTITY_NAME,
  DEMO_PROBE_SOURCE,
  runAgentRecipe,
} from "./lsp-agent-client.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// Drive the agent recipe end-to-end over the REAL framed transport (serveLspStdio),
// but in-process: a pair of TransformStreams stands in for a subprocess's
// stdin/stdout — client writes to `clientToServer`, server writes to `serverToClient`
// — so no subprocess and no project-on-disk is needed, mirroring
// lsp/server_test.ts's "full lifecycle over the framed transport". The kernel is a
// real PGlite instance (repo rule: no DB mocks) with the demo handler registered
// under the name the recipe opens.
Deno.test(
  "agent recipe: completions + diagnostics-driven self-correction over stdio",
  testOpts,
  async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testComposition() });
    try {
      // Seed the entity the recipe opens (opentide://…/handlers/getUsers.ts): its source
      // is irrelevant — every feature request rides the live override buffer the recipe
      // sends — but it must be registered so the merge path lints it.
      kernel.handlers.register(
        DEMO_ENTITY_NAME,
        DEMO_PROBE_SOURCE,
        () => new Response("[]"),
        undefined,
        "users",
      );

      // A small debounce so the pushed diagnostics arrive promptly under test.
      const server = new LspServer({ kernel, diagnosticsDebounceMs: 5 });
      const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
      const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

      // Run the server loop over the in-memory duplex; it resolves when the recipe
      // sends `exit`. Don't await it yet — the recipe drives concurrently.
      const serving = serveLspStdio(server, {
        input: clientToServer.readable,
        output: serverToClient.writable,
      });

      const result = await runAgentRecipe({
        toServer: clientToServer.writable,
        fromServer: serverToClient.readable,
      });
      await serving;

      // Identity + the Stage-8 surface contract read straight off initialize.
      assertEquals(result.serverName, "opentide");
      assertEquals(result.surfaceVersion, LSP_SURFACE_VERSION);
      assert(
        (result.surfaceFingerprint ?? "").length > 0,
        "initialize should advertise a opentideSurface fingerprint",
      );

      // Completions taught the agent the `db.` members (learn a signature).
      assert(
        result.completionLabels.includes("query"),
        `expected a "query" completion; got ${
          result.completionLabels.join(", ")
        }`,
      );

      // The self-correction delta: the broken buffer squiggled, the fix cleared it.
      assert(
        result.errorsWhenBroken.length >= 1,
        "the type-error buffer should produce at least one error diagnostic",
      );
      assert(
        result.errorsWhenBroken.some((d) => d.source === "tsc"),
        "the error should come from the TS compiler (source tsc)",
      );
      assertEquals(
        result.errorsWhenFixed.length,
        0,
        "the fixed buffer should clear every error diagnostic",
      );

      assert(server.hasExited(), "the server should have processed exit");
    } finally {
      await db.close();
    }
  },
);
