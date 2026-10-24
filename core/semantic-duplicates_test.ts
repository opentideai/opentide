import { assert, assertEquals } from "@std/assert";
import {
  DUPLICATE_BLOCK_THRESHOLD,
  findSimilarEntities,
  scoreSimilarEntity,
} from "./semantic-duplicates.ts";

Deno.test("semantic duplicate scorer blocks normalized validation variants", () => {
  const candidate = scoreSimilarEntity(
    {
      kind: "function",
      name: "isValidEmail",
      purpose: "Validate an email address.",
      source:
        "function isValidEmail(email: string): boolean { return email.includes('@'); }",
      module: "auth",
      returnType: "boolean",
    },
    {
      kind: "function",
      name: "validateEmail",
      purpose: "Validate an email address.",
      source:
        "function validateEmail(email: string): boolean { return email.includes('@'); }",
      module: "auth",
      returnType: "boolean",
    },
  );

  assert(candidate.score >= DUPLICATE_BLOCK_THRESHOLD);
  assert(candidate.reasons.includes("similar normalized names"));
});

Deno.test("semantic duplicate scorer keeps unrelated same-module functions below block threshold", () => {
  const candidate = scoreSimilarEntity(
    {
      kind: "function",
      name: "calculateInvoiceTotal",
      purpose: "Calculate invoice total from line items.",
      source:
        "function calculateInvoiceTotal(items: Array<{ amount: number }>): number { return items.reduce((sum, item) => sum + item.amount, 0); }",
      module: "billing",
      returnType: "number",
    },
    {
      kind: "function",
      name: "formatInvoiceDate",
      purpose: "Format invoice dates for display.",
      source:
        "function formatInvoiceDate(date: Date): string { return date.toISOString().slice(0, 10); }",
      module: "billing",
      returnType: "string",
    },
  );

  assert(candidate.score < DUPLICATE_BLOCK_THRESHOLD);
});

Deno.test("semantic duplicate scorer blocks exact implementation matches without metadata", () => {
  const candidate = scoreSimilarEntity(
    {
      kind: "function",
      name: "foo",
      source: "function foo(value: string): string { return value.trim(); }",
      returnType: "string",
    },
    {
      kind: "function",
      name: "bar",
      source: "function bar(value: string): string { return value.trim(); }",
      returnType: "string",
    },
  );

  assert(candidate.score >= DUPLICATE_BLOCK_THRESHOLD);
  assert(candidate.reasons.includes("exact implementation match"));
});

Deno.test("findSimilarEntities excludes same-name updates", () => {
  const candidates = findSimilarEntities(
    {
      kind: "function",
      name: "validateEmail",
      purpose: "Validate an email address.",
      source: "function validateEmail(email: string) { return true; }",
      module: "auth",
    },
    [{
      kind: "function",
      name: "validateEmail",
      purpose: "Validate an email address.",
      source: "function validateEmail(email: string) { return true; }",
      module: "auth",
    }],
    { excludeSameName: true },
  );

  assertEquals(candidates, []);
});
