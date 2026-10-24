// A user package whose name matches a dependency the generated runtime shell bundles
// (hono, @electric-sql/pglite, @hono/node-server) used to silently REPLACE it in the
// exported artifact: both emitters spread user packages after the platform pins, so
// the user's specifier landed on the platform's own manifest key.
//
// Measured before the fix, with a user `hono@3` against a shell pinned to 4:
//   Node package.json → "hono": "3"        — caught only by luck, via npm ERESOLVE
//                                            (peer hono@"^4" from @hono/node-server)
//   Deno deno.json    → "hono": "npm:hono@3" — PASSED GREEN. Health 200, route probe
//                                            200, correct body, no diagnostic. Deno
//                                            has no peer-dependency concept.
//
// The fix keeps the canonical keys for the platform and emits the colliding user copy
// under an alias, so `packages.<name>` still resolves to the user's version. These
// tests cover both targets for all three names; back out the alias in
// planAppPackageEmission (or the spread order in either emitter) and they fail.
//
// The emitted shell has since stopped importing Hono altogether, so there is no `hono`
// key in deno.json to displace any more. The entry stays — and stays aliased on both
// targets — because @hono/node-server peer-depends on hono@^4 and the Node artifact
// still has to satisfy that with OUR version, not the user's 3.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { buildNodeFiles } from "./build.ts";
import { exportProject } from "./export.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  APP_PACKAGE_ALIAS_PREFIX,
  appPackageAlias,
  assertRuntimeDependencyPins,
  planAppPackageEmission,
  runtimeDependencyNote,
} from "./runtime-dependencies.ts";
import { testStoreComposition } from "../verification/test-stores.ts";

async function withKernel(
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

// `kernel.runtime` is a shared module-level singleton, so a bare override leaks fake
// specifiers into every later test — whose gates would try to resolve them from npm.
// Save-and-restore contains the stub. Same helper as core/build_test.ts.
async function withStubbedPackages(
  kernel: Kernel,
  entries: Array<{ name: string; specifier: string }>,
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = kernel.runtime as unknown as {
    listPackages: (kernel: Kernel) => Array<
      { name: string; specifier: string; installedAt: string }
    >;
  };
  const original = runtime.listPackages;
  runtime.listPackages = () =>
    entries.map((e) => ({ ...e, installedAt: "2026-01-01T00:00:00.000Z" }));
  try {
    await fn();
  } finally {
    runtime.listPackages = original;
  }
}

// name → the user's specifier, the platform's Deno import value, and the platform's
// Node dependency value. Every runtime dependency, both targets, one table.
const COLLISIONS = [
  {
    // Node-only as a runtime dependency since the shell stopped importing it, but
    // still aliased on BOTH targets for the same reason @hono/node-server is: deps.ts
    // is emitted once and transpiled for Node, so the specifier has to match.
    name: "hono",
    userSpecifier: "npm:hono@3",
    denoPin: undefined,
    nodePin: "4.13.1",
    nodeAliasValue: "npm:hono@3",
  },
  {
    name: "@electric-sql/pglite",
    userSpecifier: "npm:@electric-sql/pglite@0.2.0",
    // Unversioned on Deno, which is what makes ANY user install of this name collide.
    denoPin: "npm:@electric-sql/pglite",
    nodePin: "0.4.5",
    nodeAliasValue: "npm:@electric-sql/pglite@0.2.0",
  },
  {
    // Node-only as a runtime dependency, but aliased on BOTH targets: deps.ts is
    // emitted once and transpiled for Node, so the specifier has to match.
    name: "@hono/node-server",
    userSpecifier: "npm:@hono/node-server@1.0.0",
    denoPin: undefined,
    nodePin: "1.19.17",
    nodeAliasValue: "npm:@hono/node-server@1.0.0",
  },
] as const;

for (const collision of COLLISIONS) {
  Deno.test(`a user "${collision.name}" does not displace the shell's pin (Deno target)`, async () => {
    await withKernel(async (kernel) => {
      await withStubbedPackages(kernel, [
        { name: collision.name, specifier: collision.userSpecifier },
      ], async () => {
        const { files } = await exportProject(kernel, { projectName: "App" });
        const imports = JSON.parse(
          files.find((f) => f.path === "deno.json")!.content!,
        ).imports as Record<string, string>;
        const alias = appPackageAlias(collision.name);

        // The platform key still carries the platform's own specifier.
        if (collision.denoPin !== undefined) {
          assertEquals(imports[collision.name], collision.denoPin);
        }
        // The user's copy is reachable, under the alias, at the user's version.
        assertEquals(imports[alias], collision.userSpecifier);

        // deps.ts imports FROM the alias but keys `packages` on the REAL name — the
        // whole point, since handler code reads `packages.<name>`.
        const deps = files.find((f) => f.path === "deps.ts")!.content!;
        // Match the `import * as _pkg_… ` line specifically, so the platform's own
        // `import { PGlite } from "@electric-sql/pglite"` is not mistaken for a user
        // import when THAT is the colliding name.
        const userImport = /^import \* as (_pkg_\S+) from "(.+)";$/gm;
        const userImports = [...deps.matchAll(userImport)].map((m) => m[2]);
        assertEquals(userImports, [alias]);
        assert(
          deps.includes(`"${collision.name}": `),
          "packages key must stay the real package name",
        );
      });
    });
  });

  Deno.test(`a user "${collision.name}" does not displace the shell's pin (Node target)`, async () => {
    await withKernel(async (kernel) => {
      await withStubbedPackages(kernel, [
        { name: collision.name, specifier: collision.userSpecifier },
      ], async () => {
        const nodeFiles = await buildNodeFiles(kernel, "App", "1.0.0");
        const deps = JSON.parse(
          nodeFiles.find((f) => f.path === "package.json")!.content!,
        ).dependencies as Record<string, string>;

        assertEquals(deps[collision.name], collision.nodePin);
        // npm alias syntax: nothing is published under the alias, so the value has to
        // name the real package.
        assertEquals(
          deps[appPackageAlias(collision.name)],
          collision.nodeAliasValue,
        );
      });
    });
  });
}

Deno.test("@electric-sql/pglite's platform import in deps.ts is not the user's copy", async () => {
  // Sharper than the generic case: deps.ts imports PGlite itself, so before the fix a
  // user install of this name pointed the generated app's own database driver at the
  // user's version.
  await withKernel(async (kernel) => {
    await withStubbedPackages(kernel, [
      {
        name: "@electric-sql/pglite",
        specifier: "npm:@electric-sql/pglite@0.2.0",
      },
    ], async () => {
      const { files } = await exportProject(kernel, { projectName: "App" });
      const deps = files.find((f) => f.path === "deps.ts")!.content!;
      assert(
        deps.includes('import { PGlite } from "@electric-sql/pglite";'),
        "the platform's own PGlite import must keep the canonical specifier",
      );
      const imports = JSON.parse(
        files.find((f) => f.path === "deno.json")!.content!,
      ).imports as Record<string, string>;
      assertEquals(imports["@electric-sql/pglite"], "npm:@electric-sql/pglite");
    });
  });
});

Deno.test("an aliased package reads the lock by its ALIAS key, not the real name", async () => {
  // npm installs an aliased dep into node_modules/<alias>. The real name's top-level
  // lock entry belongs to the PLATFORM's copy, so reading that would clamp the user's
  // package to the shell's version — the lock amplifying the bug instead of braking it.
  await withKernel(async (kernel) => {
    const packageLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { hono: "4.13.1" } },
        "node_modules/hono": { version: "4.13.1" },
        "node_modules/app-pkg-hono": { version: "3.12.12" },
      },
    });
    await withStubbedPackages(kernel, [
      { name: "hono", specifier: "npm:hono@3" },
    ], async () => {
      const nodeFiles = await buildNodeFiles(kernel, "App", "1.0.0", {
        packageLock,
      });
      const deps = JSON.parse(
        nodeFiles.find((f) => f.path === "package.json")!.content!,
      ).dependencies as Record<string, string>;
      assertEquals(deps["hono"], "4.13.1");
      assertEquals(deps["app-pkg-hono"], "npm:hono@3.12.12");
    });
  });
});

Deno.test("a non-colliding package is emitted exactly as before", async () => {
  await withKernel(async (kernel) => {
    await withStubbedPackages(kernel, [
      { name: "marked", specifier: "npm:marked@1" },
      { name: "@scope/pkg", specifier: "npm:@scope/pkg@2" },
    ], async () => {
      const { files } = await exportProject(kernel, { projectName: "App" });
      const imports = JSON.parse(
        files.find((f) => f.path === "deno.json")!.content!,
      ).imports as Record<string, string>;
      assertEquals(imports["marked"], "npm:marked@1");
      assertEquals(imports["@scope/pkg"], "npm:@scope/pkg@2");
      assert(
        !Object.keys(imports).some((k) =>
          k.startsWith(APP_PACKAGE_ALIAS_PREFIX)
        ),
        "nothing should be aliased",
      );

      const nodeFiles = await buildNodeFiles(kernel, "App", "1.0.0");
      const deps = JSON.parse(
        nodeFiles.find((f) => f.path === "package.json")!.content!,
      ).dependencies as Record<string, string>;
      assertEquals(deps["marked"], "1");
      assertEquals(deps["@scope/pkg"], "2");
    });
  });
});

Deno.test("appPackageAlias derives valid npm package names", () => {
  assertEquals(appPackageAlias("hono"), "app-pkg-hono");
  assertEquals(
    appPackageAlias("@electric-sql/pglite"),
    "app-pkg-electric-sql__pglite",
  );
  assertEquals(
    appPackageAlias("@hono/node-server"),
    "app-pkg-hono__node-server",
  );
  // Lowercase, no slash, no leading @ — otherwise it is not installable as a
  // package.json key.
  for (const name of ["hono", "@electric-sql/pglite", "@hono/node-server"]) {
    const alias = appPackageAlias(name);
    assert(/^[a-z0-9][a-z0-9._~-]*$/.test(alias), `invalid npm name: ${alias}`);
  }
});

Deno.test("planAppPackageEmission fails loudly when an alias is already claimed", () => {
  // The scope-folding is not injective, and nothing stops a user from installing a
  // package literally named `app-pkg-hono`. A loud failure beats a silently shadowed
  // manifest entry, which is the bug this machinery exists to prevent.
  assertThrows(
    () => planAppPackageEmission(["app-pkg-hono", "hono"]),
    Error,
    'package "hono" would be emitted under the module specifier "app-pkg-hono"',
  );
  // …and the ordinary case does not throw.
  assertEquals(planAppPackageEmission(["hono", "marked"]), [
    { name: "hono", moduleSpecifier: "app-pkg-hono", aliased: true },
    { name: "marked", moduleSpecifier: "marked", aliased: false },
  ]);
});

Deno.test("assertRuntimeDependencyPins rejects a displaced platform pin", () => {
  // The emission-time invariant. It lives here rather than in verification because
  // BOTH lock gates skip cleanly when the project has no committed lock — the common
  // case — and the compiled-binary target has no dependency gate at all.
  assertThrows(
    () =>
      assertRuntimeDependencyPins(
        { "@electric-sql/pglite": "npm:@electric-sql/pglite@0.2.0" },
        "deno",
        "deno.json",
      ),
    Error,
    'deno.json must pin "@electric-sql/pglite" to "npm:@electric-sql/pglite"',
  );
  assertThrows(
    () =>
      assertRuntimeDependencyPins(
        { "hono": "4.13.1", "@electric-sql/pglite": "0.4.5" },
        "node",
        "package.json",
      ),
    Error,
    '"@hono/node-server"',
  );
  // The real emitted shapes pass.
  assertRuntimeDependencyPins(
    { "@electric-sql/pglite": "npm:@electric-sql/pglite" },
    "deno",
    "deno.json",
  );
  assertRuntimeDependencyPins(
    {
      "hono": "4.13.1",
      "@hono/node-server": "1.19.17",
      "@electric-sql/pglite": "0.4.5",
    },
    "node",
    "package.json",
  );
});

Deno.test("runtimeDependencyNote fires only for the shell's own dependency names", () => {
  assertEquals(runtimeDependencyNote("marked"), undefined);
  const note = runtimeDependencyNote("hono");
  assert(note !== undefined);
  assert(note.includes("app-pkg-hono"), note);
  assert(note.includes("packages.hono"), note);
});
