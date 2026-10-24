import { assertEquals } from "@std/assert";
import { isEsbuildServiceFailure } from "./compiler.ts";

Deno.test("esbuild service failure detection covers compiled sidecar spawn failures", () => {
  assertEquals(
    isEsbuildServiceFailure(
      new Error("The service is no longer running: spawn failed"),
    ),
    true,
  );
});

Deno.test("esbuild service failure detection does not hide ordinary TypeScript errors", () => {
  assertEquals(
    isEsbuildServiceFailure(new Error('Expected ")" but found ":"')),
    false,
  );
});
