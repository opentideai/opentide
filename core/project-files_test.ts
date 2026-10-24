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
  commitProjectTextFile,
  stageProjectTextFile,
} from "./project-files.ts";
import {
  fingerprintContent,
  type SourceFileSnapshot,
} from "./codebase/source-edit.ts";
import { MAX_FILE_CONTENT_BYTES } from "./config.ts";

async function tempProject(): Promise<string> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-project-files-",
  });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "plan.md"), "# Plan\n\nStart here.\n");
  return dir;
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.data;
}

Deno.test("stageProjectTextFile previews create and update without touching disk", async () => {
  const root = await tempProject();
  try {
    const create = ok(stageProjectTextFile(root, {
      path: "docs/new-plan.md",
      content: "# New\n",
    }));
    assertEquals(create.action, "create");
    assertEquals(create.before, null);
    assertEquals(create.after, {
      path: "docs/new-plan.md",
      content: "# New\n",
    });
    assertEquals(create.baseFingerprint, null);
    assertEquals(existsSync(join(root, "docs", "new-plan.md")), false);

    const update = ok(stageProjectTextFile(root, {
      path: "docs/plan.md",
      content: "# Plan\n\nUpdated.\n",
    }));
    assertEquals(update.action, "update");
    assertEquals(
      (update.before as SourceFileSnapshot).content,
      "# Plan\n\nStart here.\n",
    );
    assertEquals(
      (update.after as SourceFileSnapshot).content,
      "# Plan\n\nUpdated.\n",
    );
    assertEquals(
      update.baseFingerprint,
      fingerprintContent("# Plan\n\nStart here.\n"),
    );
    assertEquals(read(root, "docs/plan.md"), "# Plan\n\nStart here.\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitProjectTextFile requires a preview fingerprint and writes matching creates", async () => {
  const root = await tempProject();
  try {
    const missingFingerprint = commitProjectTextFile(root, {
      path: "docs/new-plan.md",
      content: "# New\n",
    });
    assertEquals(missingFingerprint.ok, false);
    if (!missingFingerprint.ok) {
      assertEquals(missingFingerprint.error.code, "BASE_FINGERPRINT_REQUIRED");
    }

    const committed = ok(commitProjectTextFile(root, {
      path: "docs/new-plan.md",
      content: "# New\n",
      baseFingerprint: null,
    }));
    assertEquals(committed.action, "create");
    assertEquals(committed.before, null);
    assertEquals(read(root, "docs/new-plan.md"), "# New\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitProjectTextFile rejects stale fingerprints", async () => {
  const root = await tempProject();
  try {
    const preview = ok(stageProjectTextFile(root, {
      path: "docs/plan.md",
      content: "# Plan\n\nUpdated.\n",
    }));
    writeFileSync(
      join(root, "docs", "plan.md"),
      "# Plan\n\nExternally changed.\n",
    );
    const conflict = commitProjectTextFile(root, {
      path: "docs/plan.md",
      content: "# Plan\n\nUpdated.\n",
      baseFingerprint: preview.baseFingerprint,
    });
    assertEquals(conflict.ok, false);
    if (!conflict.ok) assertEquals(conflict.error.code, "PATCH_CONFLICT");
    assertEquals(read(root, "docs/plan.md"), "# Plan\n\nExternally changed.\n");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("commitProjectTextFile deletes existing files with matching fingerprints", async () => {
  const root = await tempProject();
  try {
    const preview = ok(stageProjectTextFile(root, {
      path: "docs/plan.md",
      delete: true,
    }));
    const committed = ok(commitProjectTextFile(root, {
      path: "docs/plan.md",
      delete: true,
      baseFingerprint: preview.baseFingerprint,
    }));
    assertEquals(committed.action, "delete");
    assertEquals(
      (committed.before as SourceFileSnapshot).content,
      "# Plan\n\nStart here.\n",
    );
    assertEquals(committed.after, null);
    assertEquals(existsSync(join(root, "docs", "plan.md")), false);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("project text files refuse traversal, protected files, ignored dirs, and unsupported extensions", async () => {
  const root = await tempProject();
  try {
    const cases: Array<[string, string]> = [
      ["../secret.md", "INVALID_PATH"],
      ["docs/../plan.md", "INVALID_PATH"],
      ["/etc/passwd", "INVALID_PATH"],
      [".env", "IGNORED_PATH"],
      ["opentide.json", "IGNORED_PATH"],
      ["node_modules/x.md", "IGNORED_PATH"],
      ["docs/image.png", "UNSUPPORTED_FILE_TYPE"],
    ];
    for (const [path, code] of cases) {
      const r = stageProjectTextFile(root, { path, content: "x" });
      assertEquals(r.ok, false, `expected refusal for ${path}`);
      if (!r.ok) assertEquals(r.error.code, code);
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("project text files refuse symlink escapes", async () => {
  const root = await tempProject();
  const outside = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "genie-project-files-out-",
  });
  try {
    symlinkSync(outside, join(root, "docs", "outside"));
    const r = stageProjectTextFile(root, {
      path: "docs/outside/evil.md",
      content: "# Evil\n",
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.error.code, "INVALID_PATH");
    assertEquals(existsSync(join(outside, "evil.md")), false);
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("project text files refuse binary-looking files, NUL content, and oversize content", async () => {
  const root = await tempProject();
  try {
    writeFileSync(
      join(root, "docs", "binary.md"),
      new Uint8Array([0x23, 0x00]),
    );
    const binary = stageProjectTextFile(root, {
      path: "docs/binary.md",
      content: "# Replacement\n",
    });
    assertEquals(binary.ok, false);
    if (!binary.ok) assertEquals(binary.error.code, "BINARY_FILE");

    const nul = stageProjectTextFile(root, {
      path: "docs/nul.md",
      content: "bad\0content",
    });
    assertEquals(nul.ok, false);
    if (!nul.ok) assertEquals(nul.error.code, "BINARY_FILE");

    const huge = commitProjectTextFile(root, {
      path: "docs/huge.md",
      content: "a".repeat(MAX_FILE_CONTENT_BYTES + 1),
      baseFingerprint: null,
    });
    assertEquals(huge.ok, false);
    if (!huge.ok) assertEquals(huge.error.code, "FILE_TOO_LARGE");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
