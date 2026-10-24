import { assert, assertEquals } from "@std/assert";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyUserConfigDir } from "./user-config-dir.ts";

function withConfigRoot(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "user-config-dir-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

Deno.test("adoptLegacyUserConfigDir moves tideide to opentide and links back", () => {
  withConfigRoot((root) => {
    const legacy = join(root, "tideide");
    const dir = join(root, "opentide");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.json"), '{"k":1}');

    assertEquals(adoptLegacyUserConfigDir(legacy, dir), dir);
    assertEquals(readFileSync(join(dir, "config.json"), "utf-8"), '{"k":1}');
    assert(lstatSync(legacy).isSymbolicLink());
    assertEquals(realpathSync(legacy), realpathSync(dir));
  });
});

Deno.test("adoptLegacyUserConfigDir leaves an existing opentide dir alone", () => {
  withConfigRoot((root) => {
    const legacy = join(root, "tideide");
    const dir = join(root, "opentide");
    mkdirSync(legacy);
    mkdirSync(dir);

    assertEquals(adoptLegacyUserConfigDir(legacy, dir), dir);
    assert(!lstatSync(legacy).isSymbolicLink());
  });
});

Deno.test("adoptLegacyUserConfigDir with neither dir returns the new path", () => {
  withConfigRoot((root) => {
    const dir = join(root, "opentide");
    assertEquals(adoptLegacyUserConfigDir(join(root, "tideide"), dir), dir);
    assert(!existsSync(dir));
  });
});
