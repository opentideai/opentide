// @layer core — the app export's request validators, compiled to source at export time.
//
// The live preview compiles a route's schemas with ajv at every rebuild. An export cannot:
// it is a standalone source tree with no kernel to derive schemas from and — deliberately —
// no ajv to compile them with. So ajv compiles them HERE, at export time, into plain
// JavaScript functions with no ajv left in them, and the export ships those.
//
// Why that is worth the machinery: the functions are produced by the same ajv, from the
// same schemas (core/route-validation.ts derives both hosts'), with the same options. They
// agree with the preview's runtime-compiled validators on the boolean, on the `errors`
// array down to ajv's own message strings, AND on what coerceTypes rewrote — which is what
// makes core/preview-export-parity_test.ts able to compare 400 bodies byte for byte
// instead of merely comparing statuses.
//
// The alternative was shipping ajv as a dependency of every exported app and compiling at
// boot. Cheaper to write, and rejected: it puts a third-party runtime back in the user-app
// request path that stage 10 of docs/framework-free-handler-abi-plan.md just cleared, and
// it means a pinned npm dep in core/runtime-dependencies.ts for all three export targets.

import _Ajv from "ajv";
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import _standaloneCode from "ajv/standalone";
const standaloneCode =
  _standaloneCode as unknown as typeof _standaloneCode.default;
import { compareRouteKeys } from "./route-order.ts";
import { AJV_OPTIONS, deriveRouteSchemas } from "./route-validation.ts";
import type { RouteEntry } from "./types.ts";
import { errorMessage } from "./util.ts";
import { VALIDATION_PATH } from "./export-validation.ts";

export const VALIDATORS_PATH = "validators.ts";

/** The order slots are compiled in. FIXED, because ajv numbers its generated functions
 * off instance state: change this order and every byte of the emitted module moves, which
 * core/export_determinism_test.ts would rightly call a non-reproducible build. */
const SLOTS = ["params", "query", "body"] as const;
type Slot = typeof SLOTS[number];

/** A schema ajv refused, and the route that will therefore ship unvalidated. */
export interface SkippedSchema {
  /** `${method} ${path}`, the same key the validators table uses. */
  route: string;
  slot: Slot;
  reason: string;
}

export interface GeneratedValidators {
  /** The module source, or null when no route has a compilable schema — in which case
   * validators.ts is not emitted at all and the shell gets an empty table. */
  source: string | null;
  /** Route keys that got at least one validator, in table order. */
  routes: string[];
  /** Schemas ajv refused. The preview logs these and serves the route unvalidated; the
   * export reports them so a build says which routes shipped without validation rather
   * than leaving it to a log line nobody reads. */
  skipped: SkippedSchema[];
}

// --- The two escapes -------------------------------------------------------------
//
// ajv's standalone output is self-contained for almost every keyword, but a few reach for
// a runtime helper, and `code: {esm: true}` does NOT rewrite those into imports — they
// come out as bare `require(…)`, which is broken in an ESM tree. Both helpers are small
// and both are vendored below, VERBATIM from their sources, so the emitted module stays
// import-free.
//
// Measured, ajv 8.20.0: min/maxLength reach for ucs2length, uniqueItems and a few
// equality keywords reach for equal (fast-deep-equal). Nothing else in the keyword set a
// RouteSchema can express reaches for anything. That "nothing else" is not a promise about
// future ajv versions, which is why an unrecognised specifier FAILS THE EXPORT below
// rather than being passed through to break at the user's runtime.
//
// The copies are not separately unit-tested and do not need to be: the differential in
// core/export-validators_test.ts compares generated validators against runtime-ajv ones,
// and its payload pool carries surrogate-pair strings and duplicate objects on purpose, so
// a copy that drifted from ajv's own helper fails there. That is the only comparison that
// means anything — behaving like ajv, not looking like it.
interface VendoredHelper {
  local: string;
  source: string;
}

const VENDORED: Record<string, VendoredHelper> = {
  // node_modules/ajv/dist/runtime/ucs2length.js
  "ajv/dist/runtime/ucs2length": {
    local: "__ucs2length",
    source: `// https://mathiasbynens.be/notes/javascript-encoding
// https://github.com/bestiejs/punycode.js - punycode.ucs2.decode
function __ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  let value;
  while (pos < len) {
    length++;
    value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      // high surrogate, and there is a next character
      value = str.charCodeAt(pos);
      if ((value & 0xfc00) === 0xdc00) pos++; // low surrogate
    }
  }
  return length;
}`,
  },
  // node_modules/fast-deep-equal/index.js, which ajv/dist/runtime/equal.js re-exports.
  // The Map/Set/TypedArray branches are absent from that build of fast-deep-equal too —
  // this is its es5 entry point verbatim, not a subset of it.
  "ajv/dist/runtime/equal": {
    local: "__equal",
    source: `function __equal(a, b) {
  if (a === b) return true;

  if (a && b && typeof a == "object" && typeof b == "object") {
    if (a.constructor !== b.constructor) return false;

    var length, i, keys;
    if (Array.isArray(a)) {
      length = a.length;
      if (length != b.length) return false;
      for (i = length; i-- !== 0;) {
        if (!__equal(a[i], b[i])) return false;
      }
      return true;
    }

    if (a.constructor === RegExp) {
      return a.source === b.source && a.flags === b.flags;
    }
    if (a.valueOf !== Object.prototype.valueOf) {
      return a.valueOf() === b.valueOf();
    }
    if (a.toString !== Object.prototype.toString) {
      return a.toString() === b.toString();
    }

    keys = Object.keys(a);
    length = keys.length;
    if (length !== Object.keys(b).length) return false;

    for (i = length; i-- !== 0;) {
      if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
    }

    for (i = length; i-- !== 0;) {
      var key = keys[i];
      if (!__equal(a[key], b[key])) return false;
    }

    return true;
  }

  // true if both NaN, false otherwise
  return a !== a && b !== b;
}`,
  },
};

/** Thrown when ajv's output reaches for a helper this module does not vendor. Fails the
 * export on purpose: the alternative is emitting a module with a bare `require` in it,
 * which type-checks fine here and explodes on the user's first request. */
export class UnvendoredHelperError extends Error {
  constructor(readonly specifier: string) {
    super(
      `ajv's generated validators require("${specifier}"), which the export cannot ` +
        `resolve. Vendor it in core/export-validators.ts (VENDORED) or stop emitting ` +
        `the keyword that reaches for it.`,
    );
    this.name = "UnvendoredHelperError";
  }
}

/** Rewrite every `require(…)` in ajv's output to a vendored local, and prepend the
 * helpers that were actually used. Exported so the unvendored-specifier guard below can be
 * tested on its own — it is the one branch that never fires on today's ajv and has to keep
 * working on tomorrow's. Only the ones used: an unconditional prelude would put
 * dead code in every exported app and make the emitted bytes depend on nothing. */
export function devendor(code: string): string {
  const used = new Set<string>();
  const rewritten = code.replace(
    /require\("([^"]+)"\)(?:\.default)?/g,
    (_match, specifier: string) => {
      const helper = VENDORED[specifier];
      if (!helper) throw new UnvendoredHelperError(specifier);
      used.add(specifier);
      return helper.local;
    },
  );
  // Sorted, not insertion-ordered, so the prelude does not depend on which keyword ajv
  // happened to emit first.
  const prelude = [...used].sort()
    .map((specifier) => VENDORED[specifier]!.source)
    .join("\n\n");
  return prelude ? `${prelude}\n\n${rewritten}` : rewritten;
}

const EMITTED_HEADER = `// The exported app's request validators.
//
// GENERATED at export time by ajv — the same ajv, from the same schemas and with the same
// options as the live preview's, so these functions and the preview's agree on what is
// valid, on the errors reported and on what type coercion rewrote. Nothing here imports
// anything: the two runtime helpers ajv reaches for are inlined above the validators.
//
// Do not edit. Regenerate by re-exporting the app.

// @ts-nocheck ajv emits plain JavaScript: mutated function properties, implicit any, and
// error objects whose shapes differ per keyword. It is generated, it is not read, and it
// is covered by the kernel's differential against runtime ajv.
// deno-lint-ignore-file`;

/** Compile every route's schemas to source.
 *
 * Routes are sorted here rather than trusted to arrive sorted: ajv numbers its generated
 * functions off instance state, so the emitted bytes depend on compilation order, and a
 * reproducible build cannot rest on a caller's discipline. */
export function generateValidatorsRuntimeSource(
  routes: readonly RouteEntry[],
): GeneratedValidators {
  // AJV_OPTIONS, plus the one option that is this host's alone: emit source instead of a
  // closure. Everything that decides what a validator ACCEPTS is shared.
  const ajv = new Ajv({ ...AJV_OPTIONS, code: { source: true, esm: true } });

  const skipped: SkippedSchema[] = [];
  const refs: Record<string, string> = {};
  const table: Array<{ key: string; slots: Array<[Slot, string]> }> = [];
  let next = 0;

  for (const route of [...routes].sort(compareRouteKeys)) {
    const derived = deriveRouteSchemas(route.schema);
    const key = `${route.method} ${route.path}`;
    const slots: Array<[Slot, string]> = [];

    for (const slot of SLOTS) {
      const schema = derived[slot];
      if (!schema) continue;
      const id = `v${next}`;
      try {
        // compile, not addSchema: a schema ajv refuses has to throw HERE, where it can be
        // attributed to one route and one slot and skipped. addSchema defers the failure
        // to standaloneCode, by which point the whole export is lost to one bad route.
        ajv.compile({ ...schema, $id: id });
      } catch (err) {
        // Same degradation as the preview (core/app-server.ts): the slot goes unvalidated
        // rather than failing the build. Reported, though, not swallowed.
        skipped.push({ route: key, slot, reason: errorMessage(err) });
        continue;
      }
      refs[id] = id;
      slots.push([slot, id]);
      next++;
    }

    if (slots.length > 0) table.push({ key, slots });
  }

  if (table.length === 0) return { source: null, routes: [], skipped };

  const lines = [
    EMITTED_HEADER,
    "",
    `import type { RouteValidators } from "./${VALIDATION_PATH}";`,
    "",
    devendor(standaloneCode(ajv, refs)),
    "",
    // Keyed by method and path, NOT by handler name: two routes can share one handler and
    // declare different schemas, and keying by handler would validate one against the
    // other's. The preview keys the same way, which is also what makes the two tables
    // comparable.
    "export const VALIDATORS: Record<string, RouteValidators> = {",
  ];
  for (const { key, slots } of table) {
    const entries = slots.map(([slot, id]) => `${slot}: ${id}`).join(", ");
    lines.push(`  ${JSON.stringify(key)}: { ${entries} },`);
  }
  lines.push("};", "");

  return {
    source: lines.join("\n"),
    routes: table.map((t) => t.key),
    skipped,
  };
}
