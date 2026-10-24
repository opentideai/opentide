import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type ExportFile,
  exportProject,
  fileBytes,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_PATH,
  sha256Hex,
} from "./export.ts";
import { buildNodeFiles, buildZip } from "./build.ts";
import type { Kernel } from "./registries.ts";
import type { RouteSchema } from "./types.ts";
import {
  filesFingerprint,
  populate,
  withKernel,
} from "../verification/export-fixtures.ts";

// Phase 1 (docs/production-output-hardening-plan.md): the same kernel state must
// export to byte-identical source, tar, and zip — independent of registry
// insertion order, wall-clock time, logs, or the local project path.
// Phase 2 (bottom of this file): the opt-in manifest.json describes every file
// and its sourceFingerprint is deterministic under the same conditions.
//
// The withKernel / populate / filesFingerprint fixtures are shared with the
// manifest-verification test via verification/export-fixtures.ts (a plain
// module, so importing it does not re-register that suite's Deno.test cases).

Deno.test("export is insertion-order independent (files, tar, zip identical)", async () => {
  await withKernel(async (forward) => {
    await withKernel(async (reverse) => {
      await populate(forward, "forward");
      await populate(reverse, "reverse");

      const a = await exportProject(forward, { includeEnvFile: true });
      const b = await exportProject(reverse, { includeEnvFile: true });

      assertEquals(
        await filesFingerprint(a.files),
        await filesFingerprint(b.files),
        "file list + content hashes must be identical regardless of insertion order",
      );
      assertEquals(
        await sha256Hex(a.tarball),
        await sha256Hex(b.tarball),
        "tar output must be byte-identical",
      );

      const zipA = await buildZip(forward, "Demo", "1.0.0", {
        includeEnvFile: true,
      });
      const zipB = await buildZip(reverse, "Demo", "1.0.0", {
        includeEnvFile: true,
      });
      assertEquals(
        await sha256Hex(zipA),
        await sha256Hex(zipB),
        "zip output must be byte-identical",
      );
    });
  });
});

Deno.test("re-export ignores timestamps, logs, and the local project path", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const first = await exportProject(kernel, { includeEnvFile: true });
    const firstTar = await sha256Hex(first.tarball);
    const firstFiles = await filesFingerprint(first.files);

    // Simulate wall-clock passage, request/error logs, and a machine-specific
    // project path — none of which describe canonical app state.
    kernel.log.log(
      "info",
      "system",
      "a log line that must not leak into export",
    );
    kernel.log.log("error", "handler", "another volatile log entry");
    kernel.projectDir = "/some/machine/specific/path";

    const second = await exportProject(kernel, { includeEnvFile: true });
    assertEquals(await filesFingerprint(second.files), firstFiles);
    assertEquals(await sha256Hex(second.tarball), firstTar);
  });
});

Deno.test("artifact fingerprint changes when real source changes", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const before = await filesFingerprint((await exportProject(kernel)).files);

    kernel.handlers.register(
      "alpha",
      "function alpha(c) { return c.text('CHANGED'); }",
      () => new Response(),
    );
    const after = await filesFingerprint((await exportProject(kernel)).files);

    assertNotEquals(
      before,
      after,
      "editing a handler must change the fingerprint",
    );
  });
});

Deno.test("SOURCE_DATE_EPOCH sets the tar mtime without touching source", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");

    const previous = Deno.env.get("SOURCE_DATE_EPOCH");
    try {
      Deno.env.delete("SOURCE_DATE_EPOCH");
      const base = await exportProject(kernel);

      Deno.env.set("SOURCE_DATE_EPOCH", "1700000000");
      const pinned = await exportProject(kernel);

      // The mtime lives only in the tar header, so the source file set is
      // unchanged but the archive bytes differ.
      assertEquals(
        await filesFingerprint(base.files),
        await filesFingerprint(pinned.files),
      );
      assertNotEquals(
        await sha256Hex(base.tarball),
        await sha256Hex(pinned.tarball),
      );

      // Same epoch → reproducible again.
      const pinnedAgain = await exportProject(kernel);
      assertEquals(
        await sha256Hex(pinned.tarball),
        await sha256Hex(pinnedAgain.tarball),
      );
    } finally {
      if (previous === undefined) Deno.env.delete("SOURCE_DATE_EPOCH");
      else Deno.env.set("SOURCE_DATE_EPOCH", previous);
    }
  });
});

// --- Slice 6.3: the Node package.json stays deterministic with pinned user deps ---

// The generated Node package.json is a pure function of (installed specifiers +
// committed lock bytes), so re-exporting the same kernel + lock — even with the
// packages listed in a different order — must yield byte-identical package.json.
// This guards the lock-derived pinning path against nondeterminism (the whole
// export is re-verified by verifyExportDeterminism; this pins the Node target's
// dependency section specifically).
Deno.test("Node package.json is byte-identical across re-exports with a user package + committed lock", async () => {
  const packageLock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { marked: "1", "is-number": "^7.0.0" } },
      "node_modules/marked": { version: "1.7.0" },
      "node_modules/is-number": { version: "7.0.0" },
    },
  });
  const entries = [
    { name: "marked", specifier: "npm:marked@1", installedAt: "x" },
    { name: "is-number", specifier: "npm:is-number@^7.0.0", installedAt: "x" },
  ];
  // `kernel.runtime` is a shared module-level singleton, so set-and-restore keeps
  // this stub from leaking into later tests. Toggling the returned order on one
  // kernel is the real install-order-independence probe (two kernels would share
  // the same mutated singleton).
  await withKernel(async (kernel) => {
    const runtime = kernel.runtime as unknown as {
      listPackages: (kernel: Kernel) => typeof entries;
    };
    const original = runtime.listPackages;
    const pkgJson = async () =>
      (await buildNodeFiles(kernel, "App", "1.0.0", { packageLock }))
        .find((f) => f.path === "package.json")!.content!;
    try {
      runtime.listPackages = () => entries;
      const a = await pkgJson();
      const b = await pkgJson(); // re-export, same order
      runtime.listPackages = () => [...entries].reverse();
      const c = await pkgJson(); // reversed install order
      assertEquals(a, b, "re-export must be byte-identical");
      assertEquals(a, c, "install order must not perturb the package.json");
      // The user dep is exact-pinned from the lock (not the "^7.0.0" specifier).
      assertEquals(JSON.parse(a).dependencies["is-number"], "7.0.0");
      assertEquals(JSON.parse(a).dependencies["marked"], "1.7.0");
    } finally {
      runtime.listPackages = original;
    }
  });
});

// --- Phase 2: production manifest + artifact hashing ---

interface Manifest {
  formatVersion: number;
  projectName: string;
  projectVersion: string;
  runtimeId: string;
  exportOptions: Record<string, boolean>;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  runtimeIncludePaths: string[];
  runtimePermissions: string[];
  sourceFingerprint: string;
  checks: unknown[];
  artifacts: unknown[];
}

function findManifest(files: ExportFile[]): Manifest {
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry?.content) throw new Error("manifest.json missing from export");
  return JSON.parse(entry.content) as Manifest;
}

Deno.test("manifest files[] matches every emitted file (manifest self-excluded)", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });
    const manifest = findManifest(files);

    assertEquals(manifest.formatVersion, MANIFEST_FORMAT_VERSION);

    // The manifest lists exactly the export minus itself.
    const emittedPaths = files
      .map((f) => f.path)
      .filter((p) => p !== MANIFEST_PATH)
      .sort();
    assertEquals(manifest.files.map((f) => f.path).sort(), emittedPaths);
    assertEquals(
      manifest.files.some((f) => f.path === MANIFEST_PATH),
      false,
      "manifest must not list itself",
    );

    // Each entry's hash and byte count match the real emitted bytes.
    for (const entry of manifest.files) {
      const file = files.find((f) => f.path === entry.path);
      if (!file) throw new Error(`manifest lists absent file ${entry.path}`);
      const bytes = fileBytes(file);
      assertEquals(entry.bytes, bytes.byteLength, `bytes for ${entry.path}`);
      assertEquals(
        entry.sha256,
        await sha256Hex(bytes),
        `hash for ${entry.path}`,
      );
    }
  });
});

/* The manifest states which files a compiled binary must embed, so that a build
   driver outside this repo reads the list instead of keeping its own copy of the
   rule. Speed Read's did keep its own copy, as a hand-written array of module
   asset directories, and it went stale twice: two releases shipped with four
   stylesheets and scripts absent from the binary and 404ing in production while
   the pages still returned 200. See binaryRuntimeIncludePaths.

   Two properties, and the second matters more than the first. The list has to
   name every runtime file — but it also has to name NOTHING the export does not
   carry, because `deno compile --include` on a missing path fails the build, and
   a manifest that can lie about its own contents is worse than no manifest. */
Deno.test("manifest runtimeIncludePaths covers every asset and nothing absent", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });
    const manifest = findManifest(files);
    const emitted = new Set(files.map((f) => f.path));

    // Nothing named that the export does not carry.
    for (const path of manifest.runtimeIncludePaths) {
      assertEquals(
        emitted.has(path),
        true,
        `runtimeIncludePaths names ${path}, which the export does not carry`,
      );
    }

    /* Every registered asset is in the list. This is the assertion that would
       have caught the Speed Read fault at its source: the fixture registers
       assets and the list must contain them without anyone naming a module.

       Both shapes are collected. An asset in a module is emitted at
       `<module>/assets/<name>`, and one with no module at `assets/<name>` —
       the fixture produces the second kind, which is exactly the sort of
       detail a test written against an assumed layout gets wrong. */
    const assetPaths = files
      .map((f) => f.path)
      .filter((p) => p.includes("/assets/") || p.startsWith("assets/"))
      .filter((p) => !p.startsWith("docs/"));
    assertEquals(
      assetPaths.length > 0,
      true,
      "fixture should register assets, or this test proves nothing",
    );
    for (const path of assetPaths) {
      assertEquals(
        manifest.runtimeIncludePaths.includes(path),
        true,
        `runtimeIncludePaths omits the asset ${path}`,
      );
    }

    // Generated docs are not runtime files and must not be embedded.
    assertEquals(
      manifest.runtimeIncludePaths.filter((p) => p.startsWith("docs/")),
      [],
      "generated docs are not read at runtime and must stay out of the binary",
    );

    // main.ts is compiled, not read off disk; including it would be a tell that
    // the filter had been loosened into "everything".
    assertEquals(manifest.runtimeIncludePaths.includes("main.ts"), false);
  });
});

/* The manifest states the permission set for the same reason it states the
   include list, and this is the older of the two problems: the set had three
   hand-maintained copies before APP_RUNTIME_PERMISSIONS, and a fourth still
   lives outside this repo in Speed Read's bash compile script.

   Asserted AGAINST THE GENERATED deno.json rather than against a literal or
   against the constant. A literal would be a second place to forget a flag,
   which is the fault being fixed. The constant would be circular — both sides
   read from it, so the test would pass whatever it said. The task line is the
   other artifact that has to agree, and "a compiled binary and `deno task
   start` grant the same thing" is the actual property worth holding. */
Deno.test("manifest runtimePermissions matches what the generated start task grants", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });
    const manifest = findManifest(files);

    const denoJson = files.find((f) => f.path === "deno.json");
    if (!denoJson?.content) throw new Error("deno.json missing from export");
    const startTask = String(
      (JSON.parse(denoJson.content) as { tasks?: Record<string, string> })
        .tasks?.start ?? "",
    );
    assertEquals(
      startTask.length > 0,
      true,
      "export should define a start task",
    );

    const taskFlags = startTask.split(/\s+/).filter((f) =>
      f.startsWith("--allow-")
    );
    assertEquals(
      [...manifest.runtimePermissions].sort(),
      [...taskFlags].sort(),
      "a compiled binary and `deno task start` must grant the same thing",
    );

    /* Not empty, and every entry really is a permission flag. An empty list
       would satisfy the comparison above if the task line also lost its flags,
       and a binary compiled from an empty list is one that cannot open a
       socket or a database. */
    assertEquals(
      manifest.runtimePermissions.length > 0,
      true,
      "an app with no permissions cannot serve anything",
    );
    for (const flag of manifest.runtimePermissions) {
      assertEquals(
        flag.startsWith("--allow-"),
        true,
        `runtimePermissions should hold permission flags, got ${flag}`,
      );
    }
  });
});

Deno.test("manifest is deterministic across insertion order", async () => {
  await withKernel(async (forward) => {
    await withKernel(async (reverse) => {
      await populate(forward, "forward");
      await populate(reverse, "reverse");

      const a = findManifest(
        (await exportProject(forward, { includeManifest: true })).files,
      );
      const b = findManifest(
        (await exportProject(reverse, { includeManifest: true })).files,
      );

      assertEquals(a.sourceFingerprint, b.sourceFingerprint);
      assertEquals(JSON.stringify(a), JSON.stringify(b));
    });
  });
});

Deno.test("manifest sourceFingerprint ignores timestamps, logs, and project path", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const first = findManifest(
      (await exportProject(kernel, { includeManifest: true })).files,
    );

    kernel.log.log(
      "info",
      "system",
      "a log line that must not leak into export",
    );
    kernel.log.log("error", "handler", "another volatile log entry");
    kernel.projectDir = "/some/machine/specific/path";

    const second = findManifest(
      (await exportProject(kernel, { includeManifest: true })).files,
    );
    assertEquals(second.sourceFingerprint, first.sourceFingerprint);
    assertEquals(JSON.stringify(second), JSON.stringify(first));
  });
});

Deno.test("manifest sourceFingerprint changes when real source changes", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const before = findManifest(
      (await exportProject(kernel, { includeManifest: true })).files,
    ).sourceFingerprint;

    kernel.handlers.register(
      "alpha",
      "function alpha(c) { return c.text('CHANGED'); }",
      () => new Response(),
    );
    const after = findManifest(
      (await exportProject(kernel, { includeManifest: true })).files,
    ).sourceFingerprint;

    assertNotEquals(
      before,
      after,
      "editing a handler must move the fingerprint",
    );
  });
});

Deno.test("manifest exportOptions reflects the options actually passed", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const manifest = findManifest(
      (await exportProject(kernel, {
        includeManifest: true,
        includeEnvFile: true,
        includeReadme: false,
        projectName: "Acme",
        projectVersion: "2.1.0",
      })).files,
    );

    assertEquals(manifest.projectName, "Acme");
    assertEquals(manifest.projectVersion, "2.1.0");
    assertEquals(manifest.runtimeId, kernel.runtimeId);
    // Explicit opt-ins/opt-outs are honored; unspecified README-class defaults
    // resolve on, the rest off.
    assertEquals(manifest.exportOptions.includeEnvFile, true);
    assertEquals(manifest.exportOptions.includeReadme, false);
    assertEquals(manifest.exportOptions.includeManifest, true);
    assertEquals(manifest.exportOptions.includeAgent, true);
    assertEquals(manifest.exportOptions.includeSeedData, false);
    assertEquals(manifest.exportOptions.includeGitignore, false);
  });
});

// --- Slice 4.3: productionTest is test-only metadata (never in exported bytes) ---

// The guardrail for the "productionTest rides in the registry snapshot only"
// decision: a route carrying a productionTest fixture must export to byte-identical
// openapi.json, the same source file set, and the same sourceFingerprint as the
// SAME route without it — proving the metadata never reaches exported bytes (it is
// consumed only by verification/route-smoke-plan.ts, and core/openapi.ts reads
// summary/description/tags/params/query/body/responses alone).
Deno.test("productionTest route metadata never reaches exported bytes", async () => {
  async function exportWith(includeFixture: boolean) {
    let captured!: {
      files: ExportFile[];
      openapi: string;
      fingerprint: string;
    };
    await withKernel(async (kernel) => {
      kernel.handlers.register(
        "createOrder",
        "function createOrder(c) { return c.json({ id: 1 }, 201); }",
        () => new Response(),
      );
      const schema: RouteSchema = {
        summary: "create order",
        body: { type: "object", required: ["item"] },
        responses: {
          "201": { description: "Created", schema: { type: "object" } },
        },
      };
      if (includeFixture) {
        schema.productionTest = {
          safe: true,
          exampleRequest: { pathParams: {}, query: {}, body: { item: "x" } },
          expectedStatus: 201,
          deterministicBody: true,
        };
      }
      kernel.routes.register("POST", "/orders", "createOrder", schema);

      const { files } = await exportProject(kernel, { includeManifest: true });
      const openapiEntry = files.find((f) => f.path === "openapi.json");
      if (!openapiEntry) throw new Error("openapi.json missing from export");
      captured = {
        files,
        openapi: new TextDecoder().decode(fileBytes(openapiEntry)),
        fingerprint: findManifest(files).sourceFingerprint,
      };
    });
    return captured;
  }

  const without = await exportWith(false);
  const withFixture = await exportWith(true);

  // openapi.json is byte-identical (productionTest is not an OpenAPI field).
  assertEquals(withFixture.openapi, without.openapi);
  // The manifest's sourceFingerprint (derived purely from source) is unchanged.
  assertEquals(withFixture.fingerprint, without.fingerprint);
  // Every SOURCE file is byte-identical (manifest.json excluded: it carries the
  // per-Kernel runtimeId, which differs between the two withKernel instances and
  // is unrelated to productionTest leakage).
  assertEquals(
    await filesFingerprint(
      withFixture.files.filter((f) => f.path !== MANIFEST_PATH),
    ),
    await filesFingerprint(
      without.files.filter((f) => f.path !== MANIFEST_PATH),
    ),
  );
  // Belt-and-suspenders: the literal string appears in NO exported file's bytes.
  for (const file of withFixture.files) {
    assertEquals(
      new TextDecoder().decode(fileBytes(file)).includes("productionTest"),
      false,
      `productionTest leaked into ${file.path}`,
    );
  }
});

Deno.test("manifest is opt-in: default export omits it and stays byte-identical", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const withoutFlag = await exportProject(kernel);
    const withFlagOff = await exportProject(kernel, { includeManifest: false });

    assertEquals(
      withoutFlag.files.some((f) => f.path === MANIFEST_PATH),
      false,
    );
    assertEquals(
      await sha256Hex(withoutFlag.tarball),
      await sha256Hex(withFlagOff.tarball),
    );

    const withManifest = await exportProject(kernel, { includeManifest: true });
    assertEquals(
      withManifest.files.some((f) => f.path === MANIFEST_PATH),
      true,
    );
    // Adding the manifest must not perturb any other file's bytes.
    assertEquals(
      await filesFingerprint(
        withManifest.files.filter((f) => f.path !== MANIFEST_PATH),
      ),
      await filesFingerprint(withoutFlag.files),
    );
  });
});
