export type RuntimeDependencyTarget = "deno" | "node";

export interface RuntimeDependencyTargetSpecifier {
  target: RuntimeDependencyTarget;
  specifier: string;
  version: string;
}

export interface RuntimeDependency {
  name: string;
  specifier: string;
  version: string;
  targets: readonly RuntimeDependencyTarget[];
  targetSpecifiers: readonly RuntimeDependencyTargetSpecifier[];
  appImportable: false;
  reason: string;
}

export const DENO_RUNTIME_PGLITE_SPECIFIER = "npm:@electric-sql/pglite";

export const NODE_RUNTIME_HONO_VERSION = "4.13.1";
export const NODE_RUNTIME_NODE_SERVER_VERSION = "1.19.17";
export const NODE_RUNTIME_PGLITE_VERSION = "0.4.5";

const FRAMEWORK_RUNTIME_REASON =
  "Bundled by generated app runtimes; install it as a project package to access it through packages.<name>.";

// Hono is no longer imported by anything the export emits (the shell routes on
// URLPattern — core/export-router.ts). It stays declared for the NODE target only,
// because @hono/node-server — the fetch→node:http adapter the Node artifact starts its
// server with — peer-depends on hono@^4, not optionally. Dropping the entry would stop
// planAppPackageEmission aliasing a user package named `hono`, so a project that
// installed hono@3 would put "hono": "3" at the top level of package.json and `npm ci`
// would ERESOLVE against that peer — the exact failure the alias mechanism removed, and
// only for the user following the endorsed carve-out.
const NODE_SERVER_PEER_REASON =
  "A peer of the Node artifact's server adapter (@hono/node-server); nothing the export emits imports it. Install it as a project package to access it through packages.<name>.";

export const RUNTIME_DEPENDENCIES: readonly RuntimeDependency[] = [
  {
    name: "hono",
    specifier: "hono",
    version: NODE_RUNTIME_HONO_VERSION,
    targets: ["node"],
    targetSpecifiers: [
      {
        target: "node",
        specifier: "hono",
        version: NODE_RUNTIME_HONO_VERSION,
      },
    ],
    appImportable: false,
    reason: NODE_SERVER_PEER_REASON,
  },
  {
    name: "@electric-sql/pglite",
    specifier: DENO_RUNTIME_PGLITE_SPECIFIER,
    version: "unversioned / 0.4.5",
    targets: ["deno", "node"],
    targetSpecifiers: [
      {
        target: "deno",
        specifier: DENO_RUNTIME_PGLITE_SPECIFIER,
        version: "unversioned",
      },
      {
        target: "node",
        specifier: "@electric-sql/pglite",
        version: NODE_RUNTIME_PGLITE_VERSION,
      },
    ],
    appImportable: false,
    reason: FRAMEWORK_RUNTIME_REASON,
  },
  {
    name: "@hono/node-server",
    specifier: "@hono/node-server",
    version: NODE_RUNTIME_NODE_SERVER_VERSION,
    targets: ["node"],
    targetSpecifiers: [
      {
        target: "node",
        specifier: "@hono/node-server",
        version: NODE_RUNTIME_NODE_SERVER_VERSION,
      },
    ],
    appImportable: false,
    reason: FRAMEWORK_RUNTIME_REASON,
  },
] as const;

export function runtimeDependencies(): RuntimeDependency[] {
  return RUNTIME_DEPENDENCIES.map((dependency) => ({
    ...dependency,
    targets: [...dependency.targets],
    targetSpecifiers: dependency.targetSpecifiers.map((target) => ({
      ...target,
    })),
  }));
}

// --- Name lookup, for the export emitters ---
//
// The emitters used to read the flat per-target constants above and splice them into
// a manifest literal, which meant no code could ask "is this name one of ours". The
// accessors below close that: they derive from RUNTIME_DEPENDENCIES, the single
// declaration of what the generated shell imports.
//
// This is a lookup over OUR OWN bundled dependency names — not a question about
// which web framework an app's handlers use. That distinction is what keeps it on
// the right side of the stack-choice rule — "no kernel, verification, or export code
// may read or branch on which web framework an app's handlers use"
// (docs/framework-free-handler-abi-plan.md, "Stack choice"; gated by
// core/framework-neutrality_test.ts). Special-casing the literal "hono" anywhere in
// the emitters would not be.

export function runtimeDependencyNames(
  target?: RuntimeDependencyTarget,
): string[] {
  return RUNTIME_DEPENDENCIES
    .filter((dep) => target === undefined || dep.targets.includes(target))
    .map((dep) => dep.name);
}

// TARGET-AGNOSTIC on purpose. `deps.ts` is emitted ONCE (core/export.ts) and then
// transpiled for Node (core/build.ts), so the module specifier a user package is
// imported under has to be the same string on both targets. Making this
// target-aware would leave a user package named `@hono/node-server` — a node-only
// runtime dep — imported bare in the shared `deps.ts` while package.json kept the
// platform pin, i.e. resolving to the wrong module on Node.
export function isRuntimeDependencyName(name: string): boolean {
  return RUNTIME_DEPENDENCIES.some((dep) => dep.name === name);
}

// The value the platform's own manifest entry for `name` must carry on `target`.
// The two targets spell a dependency differently — deno.json's `imports` maps a
// bare key to a full SPECIFIER (`npm:hono@4`), package.json's `dependencies` maps
// it to a bare VERSION (`4.13.1`) — so the field differs while the question ("what
// must the platform key equal?") does not. Undefined when `name` is not a runtime
// dependency on that target.
export function runtimeDependencyManifestValue(
  name: string,
  target: RuntimeDependencyTarget,
): string | undefined {
  const dep = RUNTIME_DEPENDENCIES.find((d) => d.name === name);
  const spec = dep?.targetSpecifiers.find((t) => t.target === target);
  if (!spec) return undefined;
  return target === "deno" ? spec.specifier : spec.version;
}

// The human-facing "why is this name special" line, for install-time diagnostics.
export function runtimeDependencyNote(name: string): string | undefined {
  const dep = RUNTIME_DEPENDENCIES.find((d) => d.name === name);
  if (!dep) return undefined;
  return `Package "${name}" shares a name with a dependency the exported app's runtime shell bundles (${dep.version}). ${dep.reason} The export emits your copy alongside the bundled one under the module alias "${
    appPackageAlias(name)
  }", so \`packages.${name}\` keeps resolving to YOUR version.`;
}

// --- Alias derivation, for a user package that collides with a runtime dependency ---

// The prefix for the module specifier a colliding user package is emitted under.
// The platform keeps the canonical key because the generated manifests depend on it:
// `@hono/node-server` peer-depends on `hono@^4`, which only resolves when the
// top-level `hono` in package.json is ours, and PGlite is imported bare by deps.ts.
export const APP_PACKAGE_ALIAS_PREFIX = "app-pkg-";

// The module specifier a colliding user package is imported under in the export.
// Must be a VALID NPM PACKAGE NAME, because on Node it becomes a package.json
// dependency key whose value is npm alias syntax (`npm:<realName>@<version>`):
// lowercase, no slash, no leading `@`. A scoped name folds its separator to `__`
// (`@electric-sql/pglite` → `app-pkg-electric-sql__pglite`).
//
// The folding is not injective — a user package literally named `hono__node-server`
// would derive the same alias as `@hono/node-server`. Callers therefore assert
// alias uniqueness across the whole emitted manifest and fail the export loudly
// rather than emit something wrong — see planAppPackageEmission below.
export function appPackageAlias(name: string): string {
  const folded = name.replace(/^@/, "").replace(/\//g, "__");
  return APP_PACKAGE_ALIAS_PREFIX +
    folded.toLowerCase().replace(/[^a-z0-9._~-]/g, "-");
}

// --- Emission plan: how each installed user package appears in the export ---

export interface AppPackageEmission {
  // The real package name. This is the `packages.<name>` key in deps.ts and it is
  // NEVER rewritten — handler code reads `packages.hono`, so the key has to survive
  // aliasing untouched or every already-written handler breaks.
  name: string;
  // The module specifier deps.ts imports from, and the manifest key (deno.json
  // `imports` / package.json `dependencies`) that maps it. Equal to `name` unless
  // the name collided with a runtime dependency.
  moduleSpecifier: string;
  // True when `name` collided and got the alias.
  aliased: boolean;
}

// Decide, for the sorted list of installed package names, what specifier each is
// emitted under. Non-colliding packages are returned unchanged, so a project without
// a collision emits byte-identically to before this existed.
export function planAppPackageEmission(
  names: readonly string[],
): AppPackageEmission[] {
  const emissions: AppPackageEmission[] = names.map((name) =>
    isRuntimeDependencyName(name)
      ? { name, moduleSpecifier: appPackageAlias(name), aliased: true }
      : { name, moduleSpecifier: name, aliased: false }
  );
  // Uniqueness across EVERY key the generated manifests will carry: the platform's
  // own canonical names, the untouched user names, and the derived aliases. Needed
  // because the alias folding is not injective and because nothing stops a user from
  // installing a package literally named `app-pkg-hono`. Deterministic given sorted
  // input, and a loud failure beats a silently shadowed manifest entry — which is
  // the entire bug this machinery exists to fix.
  const seen = new Set<string>(runtimeDependencyNames());
  for (const emission of emissions) {
    if (seen.has(emission.moduleSpecifier)) {
      throw new Error(
        `Cannot export: package "${emission.name}" would be emitted under the module specifier "${emission.moduleSpecifier}", which another dependency in the generated manifest already claims. Rename or remove one of them.`,
      );
    }
    seen.add(emission.moduleSpecifier);
  }
  return emissions;
}

// Assert the generated manifest still carries the platform's own pins verbatim for
// `target`, and throw otherwise. Lives at EMISSION time on purpose: both lock gates
// (verification/production-lock.ts, production-node-lock.ts) skip cleanly when the
// project has no committed lock — the common case — and the compiled-binary target
// has no dependency gate at all, so a check parked in verification would not run
// where it matters.
export function assertRuntimeDependencyPins(
  manifest: Readonly<Record<string, string>>,
  target: RuntimeDependencyTarget,
  manifestPath: string,
): void {
  for (const name of runtimeDependencyNames(target)) {
    const expected = runtimeDependencyManifestValue(name, target);
    if (expected === undefined) continue;
    const actual = manifest[name];
    if (actual === expected) continue;
    throw new Error(
      `Cannot export: ${manifestPath} must pin "${name}" to ${
        JSON.stringify(expected)
      } (the version the generated runtime shell is written against) but got ${
        JSON.stringify(actual ?? null)
      }.`,
    );
  }
}
