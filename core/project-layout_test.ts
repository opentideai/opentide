import { assert, assertEquals } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptLegacyProjectLayout,
  hasProjectManifest,
  projectManifestPath,
  projectStateDir,
} from "./project-layout.ts";

function withProjectDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "project-layout-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("a pre-rename project is moved to opentide.json and .opentide/", () => {
  withProjectDir((dir) => {
    writeFileSync(join(dir, "tideide.json"), '{"name":"old"}');
    mkdirSync(join(dir, ".tideide", "state"), { recursive: true });
    writeFileSync(join(dir, ".tideide", "state", "x.json"), "{}");
    writeFileSync(
      join(dir, ".gitignore"),
      "data/\n.tideide/caches/\n.tideide/backups/\n",
    );

    adoptLegacyProjectLayout(dir);
    assertEquals(
      readFileSync(join(dir, "opentide.json"), "utf-8"),
      '{"name":"old"}',
    );
    assert(existsSync(join(dir, ".opentide", "state", "x.json")));
    assert(!existsSync(join(dir, "tideide.json")));
    assert(!existsSync(join(dir, ".tideide")));
    assertEquals(
      readFileSync(join(dir, ".gitignore"), "utf-8"),
      "data/\n.opentide/caches/\n.opentide/backups/\n",
    );
  });
});

Deno.test("adoption never overwrites the new layout", () => {
  withProjectDir((dir) => {
    writeFileSync(join(dir, "tideide.json"), '{"name":"old"}');
    writeFileSync(join(dir, "opentide.json"), '{"name":"new"}');
    mkdirSync(join(dir, ".tideide"));
    mkdirSync(join(dir, ".opentide"));
    writeFileSync(join(dir, ".opentide", "kernel.token"), "t");

    adoptLegacyProjectLayout(dir);
    assertEquals(
      readFileSync(join(dir, "opentide.json"), "utf-8"),
      '{"name":"new"}',
    );
    assert(existsSync(join(dir, "tideide.json")));
    assert(existsSync(join(dir, ".tideide")));
  });
});

Deno.test("detection sees both layouts and moves nothing", () => {
  withProjectDir((dir) => {
    writeFileSync(join(dir, "tideide.json"), "{}");
    mkdirSync(join(dir, ".tideide"));

    assert(hasProjectManifest(dir));
    assert(existsSync(join(dir, "tideide.json")));
    assert(existsSync(join(dir, ".tideide")));
    assert(!existsSync(join(dir, "opentide.json")));
  });
});

Deno.test("paths resolve to the old layout until the project is opened", () => {
  withProjectDir((dir) => {
    writeFileSync(join(dir, "tideide.json"), "{}");
    mkdirSync(join(dir, ".tideide", "history"), { recursive: true });

    assertEquals(projectManifestPath(dir), join(dir, "tideide.json"));
    assertEquals(projectStateDir(dir), join(dir, ".tideide"));
    assert(!existsSync(join(dir, ".opentide")));
  });
});

Deno.test("an empty .opentide/ skeleton neither hides nor blocks the old layout", () => {
  withProjectDir((dir) => {
    writeFileSync(join(dir, "tideide.json"), "{}");
    mkdirSync(join(dir, ".tideide", "state"), { recursive: true });
    writeFileSync(join(dir, ".tideide", "state", "x.json"), "{}");
    mkdirSync(join(dir, ".opentide", "history", "sessions"), {
      recursive: true,
    });

    assertEquals(projectStateDir(dir), join(dir, ".tideide"));
    adoptLegacyProjectLayout(dir);
    assertEquals(projectStateDir(dir), join(dir, ".opentide"));
    assert(existsSync(join(dir, ".opentide", "state", "x.json")));
    assert(!existsSync(join(dir, ".tideide")));
  });
});
