import { assert, assertEquals } from "@std/assert";
import { calculateComplexity, checkComplexity } from "./audit-complexity.ts";

Deno.test("simple function has complexity 1", () => {
  const m = calculateComplexity(
    `
function hello() {
  return "hello";
}
`,
    "hello",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 1);
  assertEquals(m.maxNestingDepth, 0);
});

Deno.test("object literals do not inflate nesting depth", () => {
  const m = calculateComplexity(
    `
function build() {
  const config = { a: { b: { c: 1 } }, d: { e: 2 } };
  return config;
}
`,
    "build",
    "function",
  );
  // No control-flow nesting — object literals must not count.
  assertEquals(m.maxNestingDepth, 0);
});

Deno.test("single if adds 1 to complexity", () => {
  const m = calculateComplexity(
    `
function check(x: number) {
  if (x > 0) {
    return "positive";
  }
  return "non-positive";
}
`,
    "check",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 2);
});

Deno.test("if/else if/else counts correctly", () => {
  const m = calculateComplexity(
    `
function classify(x: number) {
  if (x > 0) {
    return "positive";
  } else if (x < 0) {
    return "negative";
  } else {
    return "zero";
  }
}
`,
    "classify",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 3);
});

Deno.test("for loop adds complexity", () => {
  const m = calculateComplexity(
    `
function sum(arr: number[]) {
  let total = 0;
  for (const n of arr) {
    total += n;
  }
  return total;
}
`,
    "sum",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 2);
});

Deno.test("logical operators add complexity", () => {
  const m = calculateComplexity(
    `
function validate(a: boolean, b: boolean, c: boolean) {
  return a && b || c;
}
`,
    "validate",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 3);
});

Deno.test("nullish coalescing adds complexity", () => {
  const m = calculateComplexity(
    `
function fallback(x?: string) {
  return x ?? "default";
}
`,
    "fallback",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 2);
});

Deno.test("ternary adds complexity", () => {
  const m = calculateComplexity(
    `
function abs(x: number) {
  return x >= 0 ? x : -x;
}
`,
    "abs",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 2);
});

Deno.test("switch/case counts each case", () => {
  const m = calculateComplexity(
    `
function describe(status: string) {
  switch (status) {
    case "ok": return "success";
    case "err": return "failure";
    case "warn": return "warning";
    default: return "unknown";
  }
}
`,
    "describe",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 4);
});

Deno.test("nested loops increase nesting depth", () => {
  const m = calculateComplexity(
    `
function matrix(rows: number[][], target: number) {
  for (const row of rows) {
    for (const cell of row) {
      if (cell === target) {
        return true;
      }
    }
  }
  return false;
}
`,
    "matrix",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 4);
  assert(m.maxNestingDepth >= 3);
});

Deno.test("try/catch adds complexity", () => {
  const m = calculateComplexity(
    `
function safe(fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(e);
  }
}
`,
    "safe",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 2);
});

Deno.test("strings and comments are ignored", () => {
  const m = calculateComplexity(
    `
function test() {
  // if (false) { while (true) {} }
  const s = "if (x) { for (;;) {} }";
  /* case case case */
  return s;
}
`,
    "test",
    "function",
  );
  assertEquals(m.cyclomaticComplexity, 1);
});

Deno.test("lineCount is accurate", () => {
  const source = "line1\nline2\nline3\nline4\n";
  const m = calculateComplexity(source, "test", "function");
  assertEquals(m.lineCount, 5);
});

Deno.test("parameter count detection", () => {
  const m1 = calculateComplexity(
    `function f(a: number, b: string, c: boolean) { return a; }`,
    "f",
    "function",
  );
  assertEquals(m1.parameterCount, 3);

  const m2 = calculateComplexity(
    `async function f() { return 1; }`,
    "f",
    "function",
  );
  assertEquals(m2.parameterCount, 0);

  const m3 = calculateComplexity(
    `const f = (x: number, y: number) => x + y;`,
    "f",
    "function",
  );
  assertEquals(m3.parameterCount, 2);
});

Deno.test("complex function produces high complexity", () => {
  const m = calculateComplexity(
    `
async function processOrder(order: any) {
  if (!order) { return null; }
  if (!order.items || order.items.length === 0) { return null; }
  for (const item of order.items) {
    if (item.quantity <= 0) { continue; }
    if (item.price < 0) { throw new Error("bad price"); }
    if (item.type === "digital") {
      if (item.downloadUrl) {
        // ok
      } else if (item.streamUrl) {
        // ok
      } else {
        throw new Error("no url");
      }
    } else if (item.type === "physical") {
      if (!order.shippingAddress) { throw new Error("no address"); }
      if (order.shippingAddress.country === "US" || order.shippingAddress.country === "CA") {
        // domestic
      } else {
        // international
      }
    }
  }
  try {
    const result = order.total > 100 ? "premium" : "standard";
    return result ?? "unknown";
  } catch (e) {
    return null;
  }
}
`,
    "processOrder",
    "handler",
  );
  assert(
    m.cyclomaticComplexity > 15,
    `Expected high complexity, got ${m.cyclomaticComplexity}`,
  );
});

Deno.test("checkComplexity returns null for simple code", () => {
  const result = checkComplexity(`function f(x: number) { return x + 1; }`);
  assertEquals(result, null);
});

Deno.test("checkComplexity warns for complex code", () => {
  const source = Array.from(
    { length: 25 },
    (_, i) => `if (x === ${i}) { return ${i}; }`,
  ).join("\n");
  const result = checkComplexity(`function f(x: number) {\n${source}\n}`);
  assert(result !== null);
  assertEquals(result!.level, "warning");
  assert(result!.message.includes("Cyclomatic complexity"));
});
