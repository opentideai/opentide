import { assert, assertEquals } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  commitSourceEdit,
  fingerprintContent,
  type SourceFileSnapshot,
  stageSourceEdit,
  writeSourceSnapshot,
} from "./source-edit.ts";
import { MAX_FILE_CONTENT_BYTES } from "../config.ts";

async function tempProject(): Promise<string> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-source-edit-",
  });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  return dir;
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

// Type guard: both stage/commit return Result; assert ok and narrow.
function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.data;
}

Deno.test("stageSourceEdit previews an update without touching disk", async () => {
  const root = await tempProject();
  try {
    const staged = ok(stageSourceEdit(root, {
      path: "src/index.ts",
      content: "export const x = 2;\n",
    }));
    assertEquals(staged.action, "update");
    assertEquals(staged.key, "src/index.ts");
    assertEquals(
      (staged.before as SourceFileSnapshot).content,
      "export const x = 1;\n",
    );
    assertEquals(
      (staged.after as SourceFileSnapshot).content,
      "export const x = 2;\n",
    );
    assertEquals(
      staged.baseFingerprint,
      fingerprintContent("export const x = 1;\n"),
    );
    // Preview must not write.
    assertEquals(read(root, "src/index.ts"), "export const x = 1;\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitSourceEdit writes bytes and captures the pre-image", async () => {
  const root = await tempProject();
  try {
    const committed = ok(commitSourceEdit(root, {
      path: "src/index.ts",
      content: "export const x = 42;\n",
    }));
    assertEquals(committed.action, "update");
    assertEquals(
      (committed.before as SourceFileSnapshot).content,
      "export const x = 1;\n",
    );
    assertEquals(
      (committed.after as SourceFileSnapshot).content,
      "export const x = 42;\n",
    );
    assertEquals(read(root, "src/index.ts"), "export const x = 42;\n");

    // Undo = restore the captured pre-image bytes.
    assert(writeSourceSnapshot(root, committed.key, committed.before).ok);
    assertEquals(read(root, "src/index.ts"), "export const x = 1;\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitSourceEdit create → undo removes the created file", async () => {
  const root = await tempProject();
  try {
    const committed = ok(commitSourceEdit(root, {
      path: "src/new.ts",
      content: "export const y = 1;\n",
    }));
    assertEquals(committed.action, "create");
    assertEquals(committed.before, null);
    assert(existsSync(join(root, "src", "new.ts")));

    // Undo of a create restores the null pre-image ⇒ file gone.
    assert(writeSourceSnapshot(root, committed.key, committed.before).ok);
    assert(!existsSync(join(root, "src", "new.ts")));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitSourceEdit delete → undo restores content", async () => {
  const root = await tempProject();
  try {
    const committed = ok(commitSourceEdit(root, {
      path: "src/index.ts",
      delete: true,
    }));
    assertEquals(committed.action, "delete");
    assertEquals(committed.after, null);
    assert(!existsSync(join(root, "src", "index.ts")));

    assert(writeSourceSnapshot(root, committed.key, committed.before).ok);
    assertEquals(read(root, "src/index.ts"), "export const x = 1;\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("anchored edit re-resolves against current content", async () => {
  const root = await tempProject();
  try {
    const committed = ok(commitSourceEdit(root, {
      path: "src/index.ts",
      anchor: { find: "const x = 1", replace: "const x = 99" },
    }));
    assertEquals(
      (committed.after as SourceFileSnapshot).content,
      "export const x = 99;\n",
    );
    assertEquals(read(root, "src/index.ts"), "export const x = 99;\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("anchored edit fails when the anchor is absent or ambiguous", async () => {
  const root = await tempProject();
  try {
    writeFileSync(join(root, "src", "dup.ts"), "a\na\n");
    const missing = stageSourceEdit(root, {
      path: "src/index.ts",
      anchor: { find: "not-present", replace: "x" },
    });
    assert(!missing.ok);
    assertEquals(missing.error.code, "ANCHOR_NOT_FOUND");

    const ambiguous = stageSourceEdit(root, {
      path: "src/dup.ts",
      anchor: { find: "a", replace: "b" },
    });
    assert(!ambiguous.ok);
    assertEquals(ambiguous.error.code, "ANCHOR_AMBIGUOUS");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitSourceEdit rejects a stale base fingerprint with PATCH_CONFLICT", async () => {
  const root = await tempProject();
  try {
    // Preview captures the fingerprint...
    const staged = ok(stageSourceEdit(root, {
      path: "src/index.ts",
      content: "export const x = 2;\n",
    }));
    // ...then an external write moves the file...
    writeFileSync(join(root, "src", "index.ts"), "export const x = 7;\n");
    // ...so applying with the stale fingerprint conflicts and does NOT write.
    const conflict = commitSourceEdit(root, {
      path: "src/index.ts",
      content: "export const x = 2;\n",
      baseFingerprint: staged.baseFingerprint,
    });
    assert(!conflict.ok);
    assertEquals(conflict.error.code, "PATCH_CONFLICT");
    assertEquals(read(root, "src/index.ts"), "export const x = 7;\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("path escapes are refused (traversal, absolute, ignored dir)", async () => {
  const root = await tempProject();
  try {
    for (const path of ["../secret.txt", "/etc/passwd", "node_modules/x.js"]) {
      const r = stageSourceEdit(root, { path, content: "x" });
      assert(!r.ok, `expected refusal for ${path}`);
      assert(
        r.error.code === "INVALID_PATH" || r.error.code === "IGNORED_PATH",
        `unexpected code ${r.error.code} for ${path}`,
      );
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("a symlinked directory that escapes the root is refused", async () => {
  const root = await tempProject();
  const outside = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-source-edit-out-",
  });
  try {
    // src/link → outside (a symlink dir inside the root pointing out).
    symlinkSync(outside, join(root, "src", "link"));
    const r = stageSourceEdit(root, {
      path: "src/link/evil.ts",
      content: "x",
    });
    assert(!r.ok);
    assertEquals(r.error.code, "INVALID_PATH");
    assert(!existsSync(join(outside, "evil.ts")));
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("an oversize write is refused (FILE_TOO_LARGE), not truncated", async () => {
  const root = await tempProject();
  try {
    const huge = "a".repeat(MAX_FILE_CONTENT_BYTES + 1);
    const r = commitSourceEdit(root, { path: "src/big.ts", content: huge });
    assert(!r.ok);
    assertEquals(r.error.code, "FILE_TOO_LARGE");
    assert(!existsSync(join(root, "src", "big.ts")));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("editing a binary file is refused (BINARY_FILE)", async () => {
  const root = await tempProject();
  try {
    writeFileSync(
      join(root, "logo.png"),
      new Uint8Array([0x89, 0x50, 0x00, 0x01]),
    );
    const r = stageSourceEdit(root, { path: "logo.png", content: "x" });
    assert(!r.ok);
    assertEquals(r.error.code, "BINARY_FILE");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("an empty edit (no content/anchor/delete) is refused", async () => {
  const root = await tempProject();
  try {
    const r = stageSourceEdit(root, { path: "src/index.ts" });
    assert(!r.ok);
    assertEquals(r.error.code, "EMPTY_EDIT");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
