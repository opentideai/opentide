import { assertEquals, assert } from "@std/assert";
import { parseVersionFromSpecifier, parseNameFromSpecifier, auditPackages } from "./audit-packages.ts";

Deno.test("parseVersionFromSpecifier extracts version from npm specifier", () => {
  assertEquals(parseVersionFromSpecifier("npm:hono@4"), "4");
  assertEquals(parseVersionFromSpecifier("npm:hono@4.12.21"), "4.12.21");
  assertEquals(parseVersionFromSpecifier("npm:@anthropic-ai/sdk@1.2.3"), "1.2.3");
  assertEquals(parseVersionFromSpecifier("npm:esbuild@0.25"), "0.25");
});

Deno.test("parseVersionFromSpecifier returns null for no version", () => {
  assertEquals(parseVersionFromSpecifier("npm:hono"), null);
  assertEquals(parseVersionFromSpecifier("hono"), null);
});

Deno.test("parseNameFromSpecifier extracts package name", () => {
  assertEquals(parseNameFromSpecifier("npm:hono@4"), "hono");
  assertEquals(parseNameFromSpecifier("npm:hono@4.12.21"), "hono");
  assertEquals(parseNameFromSpecifier("npm:@anthropic-ai/sdk@1.2.3"), "@anthropic-ai/sdk");
  assertEquals(parseNameFromSpecifier("npm:esbuild@0.25"), "esbuild");
});

Deno.test("auditPackages returns clean result for empty packages", async () => {
  const result = await auditPackages([]);
  assertEquals(result.issues.length, 0);
  assertEquals(result.score, 100);
  assertEquals(result.summary, "No packages installed");
  assertEquals(result.packageCount, 0);
});

Deno.test("auditPackages returns valid result shape", { sanitizeResources: false, sanitizeOps: false }, async () => {
  const result = await auditPackages([
    { name: "hono", specifier: "npm:hono@4" },
  ]);
  assert(typeof result.score === "number");
  assert(result.score >= 0 && result.score <= 100);
  assert(typeof result.summary === "string");
  assert(typeof result.packageCount === "number");
  assert(typeof result.vulnerabilities === "number");
  assert(typeof result.outdated === "number");
  assert(typeof result.deprecated === "number");
  assert(Array.isArray(result.issues));
  for (const issue of result.issues) {
    assert(["critical", "high", "medium", "low", "info"].includes(issue.severity));
    assert(typeof issue.rule === "string");
    assert(typeof issue.message === "string");
  }
});
