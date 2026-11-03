// @layer core — the project source an auditor or refuter reads.
import { assert, assertEquals } from "@std/assert";
import { buildCodeContext } from "./code-context.ts";
import type { Kernel } from "./registries.ts";

Deno.test("buildCodeContext is empty for an empty kernel", () => {
  const mockKernel = {
    routes: { list: () => [] },
    handlers: { list: () => [] },
    functions: { list: () => [] },
    templates: { list: () => [] },
  } as unknown as Kernel;

  assertEquals(buildCodeContext(mockKernel).trim(), "");
});

Deno.test("buildCodeContext includes routes and handler source", () => {
  const mockKernel = {
    routes: {
      list: () => [{ method: "GET", path: "/users", handlerName: "listUsers" }],
    },
    handlers: {
      list: () => [{
        name: "listUsers",
        source: "async function listUsers(c) { return c.json([]); }",
      }],
    },
    functions: { list: () => [] },
    templates: { list: () => [] },
  } as unknown as Kernel;

  const user = buildCodeContext(mockKernel);
  assert(user.includes("handler:listUsers"));
  assert(user.includes("listUsers(c)"));
  assert(user.includes("GET /users"));
});

Deno.test("buildCodeContext includes templates", () => {
  const mockKernel = {
    routes: { list: () => [] },
    handlers: { list: () => [] },
    functions: { list: () => [] },
    templates: {
      list:
        () => [{ name: "index", content: "<html><body>Hello</body></html>" }],
    },
  } as unknown as Kernel;

  const user = buildCodeContext(mockKernel);
  assert(user.includes("template:index"));
  assert(user.includes("<html>"));
});
