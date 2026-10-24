import { assertEquals } from "@std/assert";
import {
  type ExportFile,
  exportProject,
  fileBytes,
  MANIFEST_PATH,
  sha256Hex,
} from "../core/export.ts";
import { populate, withKernel } from "./export-fixtures.ts";
import {
  MANIFEST_FILE_SET_MISMATCH,
  MANIFEST_FINGERPRINT_MISMATCH,
  MANIFEST_HASH_MISMATCH,
  MANIFEST_INVALID,
  MANIFEST_MISSING,
  verifyExportDeterminism,
  verifyManifest,
} from "./production-manifest.ts";

// Milestone 2, first slice (docs/production-output-hardening-plan.md): the
// manifest hashes and export determinism are independently re-verifiable via two
// pure gate functions. These tests assert the verifier accepts exactly what the
// generator produces (round-trip / no drift) and rejects every tamper.

// --- Small tamper helpers ------------------------------------------------------

// Deep-copy an export file list so a test can mutate one file without disturbing
// the others' bytes.
function cloneFiles(files: ExportFile[]): ExportFile[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content,
    binary: f.binary ? new Uint8Array(f.binary) : undefined,
  }));
}

function readManifest(files: ExportFile[]): Record<string, unknown> {
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry) throw new Error("manifest.json missing from export");
  return JSON.parse(new TextDecoder().decode(fileBytes(entry)));
}

// Rewrite manifest.json's content in place with a transformed object.
function rewriteManifest(
  files: ExportFile[],
  transform: (m: Record<string, unknown>) => void,
): ExportFile[] {
  const clone = cloneFiles(files);
  const idx = clone.findIndex((f) => f.path === MANIFEST_PATH);
  const manifest = JSON.parse(
    new TextDecoder().decode(fileBytes(clone[idx]!)),
  ) as Record<string, unknown>;
  transform(manifest);
  clone[idx] = {
    path: MANIFEST_PATH,
    content: JSON.stringify(manifest, null, 2) + "\n",
  };
  return clone;
}

// Pick a real emitted (non-manifest) file's path for tamper targeting.
function firstContentPath(files: ExportFile[]): string {
  const file = files.find((f) => f.path !== MANIFEST_PATH && f.content);
  if (!file) throw new Error("no text file to tamper");
  return file.path;
}

// --- verifyManifest: happy path -----------------------------------------------

Deno.test("verifyManifest accepts a clean export (generator round-trip)", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const result = await verifyManifest(files);
    assertEquals(result.ok, true);
    if (result.ok) {
      const manifest = readManifest(files);
      assertEquals(
        result.data.sourceFingerprint,
        manifest.sourceFingerprint,
      );
      assertEquals(
        result.data.verifiedFileCount,
        (manifest.files as unknown[]).length,
      );
      // Exactly the emitted set minus the manifest itself.
      assertEquals(
        result.data.verifiedFileCount,
        files.filter((f) => f.path !== MANIFEST_PATH).length,
      );
    }
  });
});

// --- verifyManifest: tampers ---------------------------------------------------

Deno.test("verifyManifest flags a tampered file body → MANIFEST_HASH_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const target = firstContentPath(files);
    const tampered = cloneFiles(files).map((f) =>
      f.path === target
        ? { ...f, content: (f.content ?? "") + " // tampered" }
        : f
    );

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_HASH_MISMATCH);
  });
});

Deno.test("verifyManifest flags a tampered bytes count → MANIFEST_HASH_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    // Corrupt just the recorded byte count for one entry; content is untouched.
    const tampered = rewriteManifest(files, (m) => {
      const entries = m.files as Array<{ path: string; bytes: number }>;
      entries[0]!.bytes = entries[0]!.bytes + 1;
    });

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_HASH_MISMATCH);
  });
});

Deno.test("verifyManifest flags an extra files[] entry → MANIFEST_FILE_SET_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const tampered = rewriteManifest(files, (m) => {
      const entries = m.files as Array<
        { path: string; sha256: string; bytes: number }
      >;
      entries.push({ path: "ghost.ts", sha256: "0".repeat(64), bytes: 0 });
    });

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_FILE_SET_MISMATCH);
  });
});

Deno.test("verifyManifest flags a missing files[] entry → MANIFEST_FILE_SET_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const tampered = rewriteManifest(files, (m) => {
      (m.files as unknown[]).shift();
    });

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_FILE_SET_MISMATCH);
  });
});

Deno.test("verifyManifest flags a self-listed manifest → MANIFEST_FILE_SET_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const tampered = rewriteManifest(files, (m) => {
      (m.files as Array<{ path: string; sha256: string; bytes: number }>).push({
        path: MANIFEST_PATH,
        sha256: "0".repeat(64),
        bytes: 0,
      });
    });

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_FILE_SET_MISMATCH);
  });
});

Deno.test("verifyManifest flags a corrupted sourceFingerprint → MANIFEST_FINGERPRINT_MISMATCH", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const tampered = rewriteManifest(files, (m) => {
      m.sourceFingerprint = "deadbeef".repeat(8);
    });

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.code, MANIFEST_FINGERPRINT_MISMATCH);
    }
  });
});

Deno.test("verifyManifest flags a missing manifest → MANIFEST_MISSING", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel); // no manifest emitted

    const result = await verifyManifest(files);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_MISSING);
  });
});

Deno.test("verifyManifest flags garbage manifest JSON → MANIFEST_INVALID", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const tampered = cloneFiles(files).map((f) =>
      f.path === MANIFEST_PATH
        ? { path: MANIFEST_PATH, content: "{not json" }
        : f
    );

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_INVALID);
  });
});

Deno.test("verifyManifest flags a structurally invalid manifest → MANIFEST_INVALID", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    // Valid JSON, but files[] is gone.
    const tampered = cloneFiles(files).map((f) =>
      f.path === MANIFEST_PATH
        ? {
          path: MANIFEST_PATH,
          content: JSON.stringify({ sourceFingerprint: "x" }),
        }
        : f
    );

    const result = await verifyManifest(tampered);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, MANIFEST_INVALID);
  });
});

// --- verifyExportDeterminism ---------------------------------------------------

Deno.test("verifyExportDeterminism succeeds for a normal kernel", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");

    const result = await verifyExportDeterminism(kernel);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(typeof result.data.sourceFingerprint, "string");
      assertEquals(result.data.sourceFingerprint.length, 64);
    }
  });
});

Deno.test("verifyExportDeterminism is stable under log/timestamp/projectDir churn", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");

    // Volatile state that must never influence exported bytes.
    kernel.log.log(
      "info",
      "system",
      "a log line that must not leak into export",
    );
    kernel.log.log("error", "handler", "another volatile log entry");
    kernel.projectDir = "/some/machine/specific/path";

    const result = await verifyExportDeterminism(kernel, {
      includeEnvFile: true,
    });
    assertEquals(result.ok, true);
  });
});

Deno.test("verifyExportDeterminism agrees with verifyManifest on the same export", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");

    const determinism = await verifyExportDeterminism(kernel);
    const { files } = await exportProject(kernel, { includeManifest: true });
    const manifestCheck = await verifyManifest(files);

    assertEquals(determinism.ok, true);
    assertEquals(manifestCheck.ok, true);
    if (determinism.ok && manifestCheck.ok) {
      assertEquals(
        determinism.data.sourceFingerprint,
        manifestCheck.data.sourceFingerprint,
      );
    }
  });
});

// Guard against a subtle bug where the verifier hashes differently than the
// generator: prove the recomputed fingerprint equals the emitted one exactly.
Deno.test("verifier recomputes the exact fingerprint the generator wrote", async () => {
  await withKernel(async (kernel) => {
    await populate(kernel, "forward");
    const { files } = await exportProject(kernel, { includeManifest: true });

    const result = await verifyManifest(files);
    assertEquals(result.ok, true);
    if (result.ok) {
      const stored = readManifest(files).sourceFingerprint as string;
      assertEquals(result.data.sourceFingerprint, stored);
      // And a hand-recomputed hash of a known file matches its manifest entry.
      const target = files.find((f) => f.path !== MANIFEST_PATH)!;
      const manifestEntry = (readManifest(files).files as Array<
        { path: string; sha256: string }
      >).find((e) => e.path === target.path)!;
      assertEquals(await sha256Hex(fileBytes(target)), manifestEntry.sha256);
    }
  });
});
