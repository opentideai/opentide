// @layer verification — shared, non-test export fixtures: a Kernel builder plus
// a canonical entity-population routine, used by both the determinism test
// (core/export_determinism_test.ts) and the manifest-verification test
// (verification/production-manifest_test.ts). Kept in a plain module — NOT a
// *_test.ts file — so importing it does not re-register those suites' Deno.test
// cases. It exercises the real verification store factories, so it lives here in
// the verification layer (it may import core freely).
import { Database } from "../core/db.ts";
import { type ExportFile, fileBytes, sha256Hex } from "../core/export.ts";
import { Kernel } from "../core/registries.ts";
import type { TypeFieldDef } from "../core/types.ts";
import { testStoreComposition } from "./test-stores.ts";

// A stable fingerprint of a whole export: [path, content-hash] for every file,
// in the given order. Two exports with the same fingerprint are byte-for-byte
// equal file-for-file.
export async function filesFingerprint(files: ExportFile[]): Promise<string> {
  const pairs: Array<[string, string]> = [];
  for (const file of files) {
    pairs.push([file.path, await sha256Hex(fileBytes(file))]);
  }
  return JSON.stringify(pairs);
}

export function reordered<T>(items: T[], order: "forward" | "reverse"): T[] {
  return order === "forward" ? items : [...items].reverse();
}

// Register an identical set of entities on `kernel`, in forward or reverse
// insertion order, to prove the export path — not the registry — imposes order.
export async function populate(
  kernel: Kernel,
  order: "forward" | "reverse",
): Promise<void> {
  const handlers: Array<[string, string]> = [
    ["alpha", "function alpha(c) { return c.text('a'); }"],
    ["beta", "function beta(c) { return c.text('b'); }"],
    ["gamma", "function gamma(c) { return c.text('g'); }"],
  ];
  const functions: Array<[string, string]> = [
    ["addOne", "function addOne(n) { return n + 1; }"],
    ["double", "function double(n) { return n * 2; }"],
  ];
  const routes: Array<[string, string, string]> = [
    ["GET", "/a", "alpha"],
    ["POST", "/b", "beta"],
    ["GET", "/g", "gamma"],
  ];
  const templates: Array<[string, string]> = [
    ["home", "<h1>home</h1>"],
    ["about", "<h1>about</h1>"],
  ];
  const configs: Array<[string, string | number]> = [
    ["PAGE_SIZE", 25],
    ["TITLE", "Demo"],
  ];
  const types: Array<[string, TypeFieldDef[]]> = [
    ["User", [{ name: "id", type: "number" }]],
    ["Post", [{ name: "title", type: "string" }]],
  ];
  const assets: string[] = ["zeta.bin", "alpha.bin"];
  const envVars: string[] = ["Z_LAST", "A_FIRST"];
  const secrets: string[] = ["SECRET_TWO", "SECRET_ONE"];

  for (const [name, source] of reordered(handlers, order)) {
    kernel.handlers.register(name, source, () => new Response());
  }
  for (const [name, source] of reordered(functions, order)) {
    kernel.functions.register(name, source, () => 0);
  }
  for (const [method, path, handler] of reordered(routes, order)) {
    kernel.routes.register(method, path, handler, { summary: `${handler}` });
  }
  for (const [name, content] of reordered(templates, order)) {
    kernel.templates.register(name, content);
  }
  for (const [name, value] of reordered(configs, order)) {
    kernel.configs.set(name, value);
  }
  for (const [name, fields] of reordered(types, order)) {
    kernel.types.register(name, fields);
  }
  for (const name of reordered(assets, order)) {
    kernel.assets.register(
      name,
      new Uint8Array([name.length]),
      "application/octet-stream",
    );
  }
  for (const key of reordered(envVars, order)) {
    kernel.envVars.define(key, `value-${key}`);
  }
  for (const key of reordered(secrets, order)) {
    kernel.secrets.define(key);
  }
  for (
    const table of reordered(["zebra", "apple"], order)
  ) {
    await kernel.db.defineSchema(
      table,
      `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
    );
  }
}

export async function withKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    await fn(kernel);
  } finally {
    await db.close();
  }
}
