import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import {
  createProject,
  DEFAULT_PROJECT_MODE,
  duplicateProject,
  getProjectPaths,
  importProject,
  listProjects,
  openProject,
  PREVIEW_PORT_AUTO,
  PROJECT_MODE_REGISTRY_NATIVE,
  PROJECT_MODE_SOURCE_BACKED,
  projectSlug,
  readProjectMode,
  readProjectPreviewPort,
  readProjectRunConfig,
  readRegistryFile,
  removeProject,
  renameProject,
  resolvePreviewPort,
  writeProjectMode,
  writeProjectPreviewPort,
  writeProjectRunConfig,
  writeRegistryFileAtomic,
} from "./project-manager.ts";
import { APP_PORT_AUTO } from "./config.ts";
import { SecretsStore } from "./secrets.ts";
import { isolateHome, TEST_TMP_DIR } from "./test-home_test.ts";

isolateHome();

// F-10: derived filenames (e.g. the export tarball) are built from projectSlug,
// so a name like "../x" or "My/App" can never escape a target directory.
Deno.test("projectSlug is always a single safe segment (F-10)", () => {
  for (
    const [name, expected] of [
      ["../x", "x"],
      ["My/App", "my-app"],
      ["../../etc/passwd", "etc-passwd"],
    ] as const
  ) {
    assertEquals(projectSlug(name), expected);
  }
  // Names with no ASCII characters still yield a non-empty, separator-free slug.
  const cjk = projectSlug("日本語");
  assertStringIncludes(cjk, "project-");
  assertEquals(cjk.includes("/"), false);
});

function gitAvailable(): boolean {
  try {
    const result = new Deno.Command("git", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return result.success;
  } catch {
    return false;
  }
}

Deno.test("createProject writes source-control friendly project scaffold", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-project-scaffold-",
  });

  try {
    const entry = createProject(baseDir, "Scaffold App");
    const paths = getProjectPaths(entry.path);
    const gitignore = readFileSync(join(entry.path, ".gitignore"), "utf-8");
    const readme = readFileSync(join(entry.path, "README.md"), "utf-8");
    const agent = readFileSync(join(entry.path, "AGENT.md"), "utf-8");

    assertStringIncludes(gitignore, ".env");
    assertStringIncludes(gitignore, "data/");
    assertStringIncludes(gitignore, ".opentide/caches/");
    assertStringIncludes(gitignore, ".opentide/backups/");
    assertStringIncludes(
      gitignore,
      "Export intentional seed data to fixtures/.",
    );

    const ignorePatterns = gitignore.split("\n").filter((line) =>
      line && !line.startsWith("#")
    );
    assertEquals(ignorePatterns.includes("fixtures/"), false);
    assertEquals(ignorePatterns.includes(".opentide/state/"), false);
    assertEquals(ignorePatterns.includes(".opentide/history/"), false);
    assertStringIncludes(readme, "# Scaffold App");
    assertStringIncludes(
      readme,
      "This project is initialized as a git repository.",
    );
    assertStringIncludes(readme, "`README.md` and `AGENT.md`");
    assertStringIncludes(agent, "# Scaffold App");
    assertStringIncludes(
      agent,
      "Treat `opentide.json` as the project manifest",
    );
    assertStringIncludes(agent, "Regenerate this file with OpenTide");
    if (gitAvailable()) {
      assertEquals(existsSync(join(entry.path, ".git")), true);
    }
    assertEquals(paths.dataDir, join(entry.path, "data"));
    assertEquals(
      paths.schemaDir,
      join(entry.path, ".opentide", "state", "schemas"),
    );
    assertEquals(paths.historyDir, join(entry.path, ".opentide", "history"));
    assertEquals(
      paths.artifactsDir,
      join(entry.path, ".opentide", "history", "artifacts"),
    );
    assertEquals(
      paths.screenshotArtifactsDir,
      join(entry.path, ".opentide", "history", "artifacts", "screenshots"),
    );
    assertEquals(
      paths.logsCache,
      join(entry.path, ".opentide", "caches", "logs.json"),
    );
    assertEquals(
      paths.localState,
      join(entry.path, ".opentide", "caches", "local-state.json"),
    );
  } finally {
    removeProject(join(baseDir, "scaffold-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// F-02: a name with no ASCII-representable characters used to slugify to "",
// and createProject then resolved to the parent dir itself — scaffolding the
// project directly into the container instead of a subdirectory.
Deno.test("createProject: a fully non-ASCII name gets a real subdirectory (F-02)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-nonascii-",
  });
  const created: string[] = [];
  try {
    const entry = createProject(baseDir, "日本語アプリ");
    created.push(entry.path);
    // It must NOT collapse onto baseDir itself.
    assertNotEquals(entry.path, baseDir);
    assertEquals(entry.path.startsWith(baseDir + sep), true);
    assertStringIncludes(basename(entry.path), "project-");
    // The manifest lives in the subdirectory, and baseDir is not polluted.
    assertEquals(existsSync(join(entry.path, "opentide.json")), true);
    assertEquals(existsSync(join(baseDir, "opentide.json")), false);
    // Two distinct non-ASCII names get distinct slugs (hash-derived).
    const other = createProject(baseDir, "한국어앱");
    created.push(other.path);
    assertNotEquals(other.path, entry.path);
  } finally {
    for (const p of created) removeProject(p);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// F-01: accented Latin now transliterates (NFKD) instead of being dropped, and
// long names are length-capped.
Deno.test("createProject: slug transliterates accents and caps length (F-01)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-slug-",
  });
  const created: string[] = [];
  try {
    const accented = createProject(baseDir, "Ünïcödé Café");
    created.push(accented.path);
    assertEquals(basename(accented.path), "unicode-cafe");

    const longName = "x".repeat(200);
    const capped = createProject(baseDir, longName);
    created.push(capped.path);
    assertEquals(basename(capped.path).length <= 60, true);
  } finally {
    for (const p of created) removeProject(p);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("duplicateProject copies hidden files, git data, local data, and caches", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-full-",
  });
  let duplicatePath = "";
  try {
    const entry = createProject(baseDir, "Copy Rich App");
    const paths = getProjectPaths(entry.path);

    writeFileSync(join(entry.path, ".env"), "SECRET=source\n");
    mkdirSync(join(entry.path, ".git"), { recursive: true });
    writeFileSync(join(entry.path, ".git", "duplicate-marker"), "git-state");
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(join(paths.dataDir, "rows.json"), '{"rows":[1]}\n');
    mkdirSync(paths.cacheDir, { recursive: true });
    writeFileSync(join(paths.cacheDir, "cache.json"), '{"cached":true}\n');
    mkdirSync(paths.historyDir, { recursive: true });
    writeFileSync(join(paths.historyDir, "event.json"), '{"event":1}\n');
    mkdirSync(paths.assets, { recursive: true });
    writeFileSync(join(paths.assets, "logo.txt"), "asset");
    mkdirSync(join(entry.path, "src"), { recursive: true });
    writeFileSync(join(entry.path, "src", "main.ts"), "export const x = 1;\n");

    const duplicate = duplicateProject(entry.path);
    duplicatePath = duplicate.path;

    assertEquals(duplicate.name, "Copy Rich App Copy 1");
    assertEquals(
      readFileSync(join(duplicate.path, ".env"), "utf-8"),
      "SECRET=source\n",
    );
    assertEquals(
      readFileSync(join(duplicate.path, ".git", "duplicate-marker"), "utf-8"),
      "git-state",
    );
    assertEquals(
      readFileSync(join(duplicate.path, "data", "rows.json"), "utf-8"),
      '{"rows":[1]}\n',
    );
    assertEquals(
      readFileSync(
        join(duplicate.path, ".opentide", "caches", "cache.json"),
        "utf-8",
      ),
      '{"cached":true}\n',
    );
    assertEquals(
      readFileSync(
        join(duplicate.path, ".opentide", "history", "event.json"),
        "utf-8",
      ),
      '{"event":1}\n',
    );
    assertEquals(
      readFileSync(join(duplicate.path, "assets", "logo.txt"), "utf-8"),
      "asset",
    );
    assertEquals(
      readFileSync(join(duplicate.path, "src", "main.ts"), "utf-8"),
      "export const x = 1;\n",
    );
  } finally {
    if (duplicatePath) removeProject(duplicatePath);
    removeProject(join(baseDir, "copy-rich-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("duplicateProject increments Copy 1 and Copy 2 on collisions", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-increment-",
  });
  const created: string[] = [];
  try {
    const source = createProject(baseDir, "Collision App");
    created.push(source.path);

    const first = duplicateProject(source.path);
    created.push(first.path);
    const second = duplicateProject(source.path);
    created.push(second.path);

    assertEquals(first.name, "Collision App Copy 1");
    assertEquals(basename(first.path), "collision-app-copy-1");
    assertEquals(second.name, "Collision App Copy 2");
    assertEquals(basename(second.path), "collision-app-copy-2");
  } finally {
    for (const path of created) removeProject(path);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("duplicateProject updates only copied manifest identity fields", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-manifest-",
  });
  let duplicatePath = "";
  try {
    const source = createProject(baseDir, "Manifest App");
    const sourceManifestPath = getProjectPaths(source.path).manifest;
    const sourceManifest = JSON.parse(
      readFileSync(sourceManifestPath, "utf-8"),
    );
    sourceManifest.createdAt = "2001-02-03T04:05:06.000Z";
    sourceManifest.previewPort = 4567;
    sourceManifest.mode = PROJECT_MODE_SOURCE_BACKED;
    sourceManifest.sourceRun = {
      command: "npm run dev",
      cwd: "web",
      port: 5173,
    };
    sourceManifest.future = { nested: ["kept"] };
    writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest, null, 2));

    const duplicate = duplicateProject(source.path);
    duplicatePath = duplicate.path;
    const copiedManifest = JSON.parse(
      readFileSync(getProjectPaths(duplicate.path).manifest, "utf-8"),
    );

    assertEquals(copiedManifest.name, "Manifest App Copy 1");
    assertNotEquals(copiedManifest.createdAt, "2001-02-03T04:05:06.000Z");
    assertEquals(copiedManifest.previewPort, 4567);
    assertEquals(copiedManifest.mode, PROJECT_MODE_SOURCE_BACKED);
    assertEquals(copiedManifest.sourceRun, {
      command: "npm run dev",
      cwd: "web",
      port: 5173,
    });
    assertEquals(copiedManifest.future, { nested: ["kept"] });
  } finally {
    if (duplicatePath) removeProject(duplicatePath);
    removeProject(join(baseDir, "manifest-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("duplicateProject leaves the source project unchanged", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-source-",
  });
  let duplicatePath = "";
  try {
    const source = createProject(baseDir, "Source Stable App");
    const manifestPath = getProjectPaths(source.path).manifest;
    writeFileSync(join(source.path, ".hidden"), "hidden source");
    writeFileSync(join(source.path, "source.txt"), "source file");
    const manifestBefore = readFileSync(manifestPath, "utf-8");
    const hiddenBefore = readFileSync(join(source.path, ".hidden"), "utf-8");
    const sourceBefore = readFileSync(join(source.path, "source.txt"), "utf-8");

    duplicatePath = duplicateProject(source.path).path;

    assertEquals(readFileSync(manifestPath, "utf-8"), manifestBefore);
    assertEquals(
      readFileSync(join(source.path, ".hidden"), "utf-8"),
      hiddenBefore,
    );
    assertEquals(
      readFileSync(join(source.path, "source.txt"), "utf-8"),
      sourceBefore,
    );
  } finally {
    if (duplicatePath) removeProject(duplicatePath);
    removeProject(join(baseDir, "source-stable-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("duplicateProject removes copied folder when registry write fails", async () => {
  const oldHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-rollback-home-",
  });
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-duplicate-rollback-",
  });
  const tideDir = join(home, ".config", "opentide");
  const duplicatePath = join(baseDir, "rollback-duplicate-app-copy-1");

  try {
    Deno.env.set("HOME", home);
    const pm = await import(
      `./project-manager.ts?duplicate-rollback-${crypto.randomUUID()}`
    );
    const source = pm.createProject(baseDir, "Rollback Duplicate App");

    chmodSync(tideDir, 0o555);

    assertThrows(
      () => pm.duplicateProject(source.path),
      Error,
    );

    chmodSync(tideDir, 0o755);
    assertEquals(existsSync(duplicatePath), false);
    assertEquals(
      pm.listProjects().some((p: { path: string }) => p.path === duplicatePath),
      false,
    );
  } finally {
    if (existsSync(tideDir)) chmodSync(tideDir, 0o755);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("renameProject updates manifest and registry path/name", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-basic-",
  });
  let renamedPath = "";
  try {
    const source = createProject(baseDir, "Rename App");
    renamedPath = join(baseDir, "renamed-folder");

    const renamed = renameProject(source.path, {
      name: "Renamed App",
      folderName: "renamed-folder",
    });

    assertEquals(renamed.path, renamedPath);
    assertEquals(renamed.name, "Renamed App");
    assertEquals(existsSync(source.path), false);
    assertEquals(existsSync(renamedPath), true);
    assertEquals(
      JSON.parse(readFileSync(getProjectPaths(renamedPath).manifest, "utf-8"))
        .name,
      "Renamed App",
    );
    assertEquals(
      listProjects().some((p) =>
        p.path === renamedPath && p.name === "Renamed App"
      ),
      true,
    );
    assertEquals(listProjects().some((p) => p.path === source.path), false);
  } finally {
    if (renamedPath) removeProject(renamedPath);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("renameProject preserves manifest keys and registry lastOpenedAt", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-preserve-",
  });
  let renamedPath = "";
  try {
    const source = createProject(baseDir, "Preserve Rename App");
    const registryBefore = listProjects().find((p) => p.path === source.path);
    const manifestPath = getProjectPaths(source.path).manifest;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.createdAt = "1999-01-02T03:04:05.000Z";
    manifest.previewPort = 3456;
    manifest.future = { retained: true };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const renamed = renameProject(source.path, {
      name: "Preserved Name",
      folderName: "preserved-folder",
    });
    renamedPath = renamed.path;

    const renamedManifest = JSON.parse(
      readFileSync(getProjectPaths(renamed.path).manifest, "utf-8"),
    );
    assertEquals(renamed.createdAt, "1999-01-02T03:04:05.000Z");
    assertEquals(renamed.lastOpenedAt, registryBefore?.lastOpenedAt);
    assertEquals(renamedManifest.name, "Preserved Name");
    assertEquals(renamedManifest.createdAt, "1999-01-02T03:04:05.000Z");
    assertEquals(renamedManifest.previewPort, 3456);
    assertEquals(renamedManifest.future, { retained: true });
  } finally {
    if (renamedPath) removeProject(renamedPath);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("renameProject rejects invalid folder names without changing source", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-invalid-",
  });
  try {
    const source = createProject(baseDir, "Invalid Rename App");
    const manifestPath = getProjectPaths(source.path).manifest;
    const manifestBefore = readFileSync(manifestPath, "utf-8");

    for (const folderName of ["", "  ", ".", "..", "a/b", "a\\b", "a\0b"]) {
      assertThrows(
        () => renameProject(source.path, { name: "Valid Name", folderName }),
        Error,
      );
      assertEquals(existsSync(source.path), true);
      assertEquals(readFileSync(manifestPath, "utf-8"), manifestBefore);
    }
  } finally {
    removeProject(join(baseDir, "invalid-rename-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("renameProject rejects destination collision without moving or rewriting source", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-collision-",
  });
  try {
    const source = createProject(baseDir, "Collision Source App");
    const destination = createProject(baseDir, "Collision Destination App");
    const sourceManifestPath = getProjectPaths(source.path).manifest;
    const manifestBefore = readFileSync(sourceManifestPath, "utf-8");

    assertThrows(
      () =>
        renameProject(source.path, {
          name: "Should Not Apply",
          folderName: basename(destination.path),
        }),
      Error,
      "Destination already exists",
    );

    assertEquals(existsSync(source.path), true);
    assertEquals(existsSync(destination.path), true);
    assertEquals(readFileSync(sourceManifestPath, "utf-8"), manifestBefore);
    assertEquals(
      listProjects().some((p) =>
        p.path === source.path && p.name === source.name
      ),
      true,
    );
  } finally {
    removeProject(join(baseDir, "collision-source-app"));
    removeProject(join(baseDir, "collision-destination-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("renameProject rolls back when manifest write fails after folder move", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-rollback-",
  });
  let sourcePath = "";
  const renamedPath = join(baseDir, "rollback-renamed");
  try {
    const source = createProject(baseDir, "Rollback Rename App");
    sourcePath = source.path;
    const manifestPath = getProjectPaths(sourcePath).manifest;
    const manifestBefore = readFileSync(manifestPath, "utf-8");

    chmodSync(sourcePath, 0o555);

    assertThrows(
      () =>
        renameProject(sourcePath, {
          name: "Should Roll Back",
          folderName: "rollback-renamed",
        }),
      Error,
    );

    chmodSync(sourcePath, 0o755);
    assertEquals(existsSync(sourcePath), true);
    assertEquals(existsSync(renamedPath), false);
    assertEquals(readFileSync(manifestPath, "utf-8"), manifestBefore);
    assertEquals(
      listProjects().some((p) =>
        p.path === sourcePath && p.name === "Rollback Rename App"
      ),
      true,
    );
    assertEquals(listProjects().some((p) => p.path === renamedPath), false);
  } finally {
    if (existsSync(sourcePath)) chmodSync(sourcePath, 0o755);
    if (existsSync(renamedPath)) chmodSync(renamedPath, 0o755);
    if (sourcePath) removeProject(sourcePath);
    removeProject(renamedPath);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("SecretsStore.moveProjectSecrets moves stored secrets between path identities", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-secrets-move-",
  });
  const oldPath = join(baseDir, "old-project");
  const newPath = join(baseDir, "new-project");
  try {
    SecretsStore.deleteProjectSecrets(oldPath);
    SecretsStore.deleteProjectSecrets(newPath);

    const oldStore = new SecretsStore();
    oldStore.load(oldPath);
    oldStore.define("API_KEY", "test key");
    oldStore.setValue("API_KEY", "secret-value");

    assertEquals(SecretsStore.moveProjectSecrets(oldPath, newPath), true);

    const moved = new SecretsStore();
    moved.load(newPath);
    assertEquals(moved.get("API_KEY")?.value, "secret-value");

    const oldAfterMove = new SecretsStore();
    oldAfterMove.load(oldPath);
    assertEquals(oldAfterMove.list(), []);
  } finally {
    SecretsStore.deleteProjectSecrets(oldPath);
    SecretsStore.deleteProjectSecrets(newPath);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("renameProject migrates secrets and external backups", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-rename-resources-",
  });
  let oldPath = "";
  let newPath = "";
  try {
    const source = createProject(baseDir, "Resource Rename App");
    oldPath = source.path;
    newPath = join(baseDir, "resource-renamed");
    SecretsStore.deleteProjectSecrets(oldPath);
    SecretsStore.deleteProjectSecrets(newPath);
    rmSync(getProjectPaths(oldPath).backups, { recursive: true, force: true });
    rmSync(getProjectPaths(newPath).backups, { recursive: true, force: true });

    const store = new SecretsStore();
    store.load(oldPath);
    store.define("TOKEN", "token");
    store.setValue("TOKEN", "abc123");
    mkdirSync(getProjectPaths(oldPath).backups, { recursive: true });
    writeFileSync(
      join(getProjectPaths(oldPath).backups, "backup.json"),
      '{"ok":true}\n',
    );

    const renamed = renameProject(oldPath, {
      name: "Resource Renamed",
      folderName: "resource-renamed",
    });

    const movedSecrets = new SecretsStore();
    movedSecrets.load(renamed.path);
    assertEquals(movedSecrets.get("TOKEN")?.value, "abc123");
    assertEquals(
      existsSync(join(getProjectPaths(oldPath).backups, "backup.json")),
      false,
    );
    assertEquals(
      readFileSync(
        join(getProjectPaths(newPath).backups, "backup.json"),
        "utf-8",
      ),
      '{"ok":true}\n',
    );
  } finally {
    if (newPath) removeProject(newPath);
    if (oldPath) removeProject(oldPath);
    if (oldPath) {
      SecretsStore.deleteProjectSecrets(oldPath);
      rmSync(getProjectPaths(oldPath).backups, {
        recursive: true,
        force: true,
      });
    }
    if (newPath) {
      SecretsStore.deleteProjectSecrets(newPath);
      rmSync(getProjectPaths(newPath).backups, {
        recursive: true,
        force: true,
      });
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// F-09: a corrupt registry.json must degrade to an empty registry (quarantining
// the bad file) rather than throwing and bricking every project operation; and
// writes must be atomic (no stray .tmp, target fully written).
Deno.test("registry: corrupt file degrades to empty and is quarantined (F-09)", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-registry-",
  });
  try {
    const path = join(dir, "registry.json");

    // Atomic write leaves no temp file and a readable target.
    writeRegistryFileAtomic(path, {
      version: 1,
      projects: [{
        path: "/tmp/x",
        name: "X",
        createdAt: "t",
        lastOpenedAt: "t",
      }],
    });
    assertEquals(existsSync(`${path}.tmp`), false);
    assertEquals(readRegistryFile(path).projects.length, 1);

    // A truncated/corrupt file does not throw — it degrades and quarantines.
    writeFileSync(path, "{ this is not valid json");
    const recovered = readRegistryFile(path);
    assertEquals(recovered.projects.length, 0);
    assertEquals(existsSync(`${path}.corrupt`), true);
    // A missing file is simply an empty registry.
    assertEquals(readRegistryFile(join(dir, "nope.json")).projects.length, 0);
    // Sanity: nothing else leaked into the dir.
    assertEquals(readdirSync(dir).includes("registry.json.tmp"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F-09 (companion): a corrupt project manifest yields a clear error, not a raw
// SyntaxError. Throws before the registry is touched.
Deno.test("openProject: corrupt manifest throws a clear error (F-09)", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-manifest-",
  });
  try {
    writeFileSync(join(dir, "opentide.json"), "{ broken json");
    assertThrows(
      () => openProject(dir),
      Error,
      "Corrupt project manifest",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A2 — preview-port persistence. A fixed pin and "auto" both round-trip through
// --- Project import (adopt-to-run on-ramp) ---

Deno.test("importProject: adopts an existing directory in place as source-backed", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-import-",
  });
  try {
    // An existing project's own files — must survive untouched.
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "acme",
        scripts: { dev: "vite", test: "vitest" },
      }),
    );
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "index.ts"),
      "export const x = 1;",
    );

    const entry = importProject(dir, "Acme");
    // Adopts the dir ITSELF — no name-slug subdirectory (unlike createProject).
    assertEquals(entry.path, dir);
    assertEquals(entry.name, "Acme");
    assertEquals(readProjectMode(dir), PROJECT_MODE_SOURCE_BACKED);
    assertEquals(
      await Deno.readTextFile(join(dir, "src", "index.ts")),
      "export const x = 1;",
    );
  } finally {
    removeProject(dir);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("importProject: defaults the name to the folder and never nests", async () => {
  const parent = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-import-base-",
  });
  const projectDir = join(parent, "my-existing-app");
  await Deno.mkdir(projectDir, { recursive: true });
  await Deno.writeTextFile(join(projectDir, "package.json"), "{}");
  try {
    const entry = importProject(projectDir);
    assertEquals(entry.path, projectDir);
    assertEquals(entry.name, "my-existing-app");
    assertEquals(readProjectMode(projectDir), PROJECT_MODE_SOURCE_BACKED);
    // The manifest lives INSIDE the existing dir, not a slug subdir.
    assertEquals(
      (await Deno.stat(getProjectPaths(projectDir).manifest)).isFile,
      true,
    );
  } finally {
    removeProject(projectDir);
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("importProject: re-adopting a registry-native project flips it to source-backed", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-import-flip-",
  });
  try {
    const created = createProject(baseDir, "Existing"); // registry-native
    assertEquals(readProjectMode(created.path), PROJECT_MODE_REGISTRY_NATIVE);
    // A pre-existing key must survive the mode flip (atomic RMW).
    writeProjectPreviewPort(created.path, 4321);

    const entry = importProject(created.path);
    assertEquals(entry.path, created.path);
    assertEquals(readProjectMode(created.path), PROJECT_MODE_SOURCE_BACKED);
    assertEquals(readProjectPreviewPort(created.path), 4321);
  } finally {
    removeProject(join(baseDir, "existing"));
    await Deno.remove(baseDir, { recursive: true });
  }
});

// write → read, and the write is atomic (no stray .tmp on success).
Deno.test("previewPort: write/read round-trips auto and a fixed port (A2)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-preview-roundtrip-",
  });
  try {
    const entry = createProject(baseDir, "Preview App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // A fresh manifest has no previewPort and reads back as auto.
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);

    // Fixed port round-trips.
    const fixed = writeProjectPreviewPort(entry.path, 4321);
    assertEquals(fixed.ok, true);
    assertEquals(readProjectPreviewPort(entry.path), 4321);
    assertEquals(existsSync(`${manifestPath}.tmp`), false);

    // "auto" round-trips (explicitly stored as the sentinel).
    const auto = writeProjectPreviewPort(entry.path, PREVIEW_PORT_AUTO);
    assertEquals(auto.ok, true);
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);
    assertEquals(existsSync(`${manifestPath}.tmp`), false);
  } finally {
    removeProject(join(baseDir, "preview-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// The read-modify-write preserves every other manifest key — name, createdAt,
// and any unknown/future key must survive unclobbered.
Deno.test("previewPort: write preserves other manifest keys (A2)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-preview-preserve-",
  });
  try {
    const entry = createProject(baseDir, "Keep Keys App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // Inject an extra key that neither createProject nor the helpers know about.
    const before = JSON.parse(readFileSync(manifestPath, "utf-8"));
    before.futureField = { nested: [1, 2, 3] };
    writeFileSync(manifestPath, JSON.stringify(before, null, 2));

    const result = writeProjectPreviewPort(entry.path, 5000);
    assertEquals(result.ok, true);

    const after = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assertEquals(after.name, "Keep Keys App");
    assertEquals(after.createdAt, before.createdAt);
    assertEquals(after.futureField, { nested: [1, 2, 3] });
    assertEquals(after.previewPort, 5000);
  } finally {
    removeProject(join(baseDir, "keep-keys-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// An out-of-range or non-integer fixed port is rejected with a semantic Result
// error and the manifest is left byte-for-byte unchanged.
Deno.test("previewPort: invalid fixed port rejected, manifest unchanged (A2)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-preview-invalid-",
  });
  try {
    const entry = createProject(baseDir, "Invalid Port App");
    const manifestPath = getProjectPaths(entry.path).manifest;
    const original = readFileSync(manifestPath, "utf-8");

    for (const bad of [0, -1, 70000, 3000.5]) {
      const result = writeProjectPreviewPort(entry.path, bad);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.code, "INVALID_PREVIEW_PORT");
      }
      // Manifest untouched, no stray tmp file.
      assertEquals(readFileSync(manifestPath, "utf-8"), original);
      assertEquals(existsSync(`${manifestPath}.tmp`), false);
    }
  } finally {
    removeProject(join(baseDir, "invalid-port-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// Project mode (project import Slice 1): new projects scaffold as
// registry-native, mode round-trips, and a fresh manifest without a `mode` key
// reads back as the default so existing projects are unaffected.
Deno.test("projectMode: new projects default to registry-native and round-trip", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-mode-roundtrip-",
  });
  try {
    const entry = createProject(baseDir, "Mode App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // Scaffold writes the default explicitly.
    assertEquals(DEFAULT_PROJECT_MODE, PROJECT_MODE_REGISTRY_NATIVE);
    assertEquals(
      JSON.parse(readFileSync(manifestPath, "utf-8")).mode,
      PROJECT_MODE_REGISTRY_NATIVE,
    );
    assertEquals(readProjectMode(entry.path), PROJECT_MODE_REGISTRY_NATIVE);

    // Flip to source-backed and back.
    const toSource = writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED);
    assertEquals(toSource.ok, true);
    assertEquals(readProjectMode(entry.path), PROJECT_MODE_SOURCE_BACKED);
    assertEquals(existsSync(`${manifestPath}.tmp`), false);

    const toNative = writeProjectMode(entry.path, PROJECT_MODE_REGISTRY_NATIVE);
    assertEquals(toNative.ok, true);
    assertEquals(readProjectMode(entry.path), PROJECT_MODE_REGISTRY_NATIVE);
  } finally {
    removeProject(join(baseDir, "mode-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// A manifest without a `mode` key (an existing pre-import project) reads back as
// the default, and writing mode preserves every other key.
Deno.test("projectMode: absent field defaults; write preserves other keys", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-mode-legacy-",
  });
  try {
    const entry = createProject(baseDir, "Legacy Mode App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // Simulate a pre-import manifest: no `mode`, plus an unknown future key.
    const legacy = { name: "Legacy Mode App", createdAt: "t", extra: [1, 2] };
    writeFileSync(manifestPath, JSON.stringify(legacy, null, 2));
    assertEquals(readProjectMode(entry.path), DEFAULT_PROJECT_MODE);

    const written = writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED);
    assertEquals(written.ok, true);
    const after = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assertEquals(after.name, "Legacy Mode App");
    assertEquals(after.createdAt, "t");
    assertEquals(after.extra, [1, 2]);
    assertEquals(after.mode, PROJECT_MODE_SOURCE_BACKED);

    // An unrecognized mode is rejected and leaves the manifest unchanged.
    const original = readFileSync(manifestPath, "utf-8");
    const bad = writeProjectMode(
      entry.path,
      "bogus" as typeof PROJECT_MODE_SOURCE_BACKED,
    );
    assertEquals(bad.ok, false);
    if (!bad.ok) assertEquals(bad.error.code, "INVALID_PROJECT_MODE");
    assertEquals(readFileSync(manifestPath, "utf-8"), original);
  } finally {
    removeProject(join(baseDir, "legacy-mode-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// A corrupt or ill-typed previewPort field (and a missing manifest) reads back
// as auto — never throws.
Deno.test("previewPort: corrupt/missing field reads back as auto (A2)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-preview-corrupt-",
  });
  try {
    const entry = createProject(baseDir, "Corrupt Field App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // Ill-typed value coerces to auto.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "Corrupt Field App",
        createdAt: "t",
        previewPort: "not-a-port",
      }),
    );
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);

    // Out-of-range stored value also coerces to auto.
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: "x", createdAt: "t", previewPort: 0 }),
    );
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);

    // Corrupt JSON reads back as auto without throwing.
    writeFileSync(manifestPath, "{ broken json");
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);

    // A missing manifest is auto.
    assertEquals(
      readProjectPreviewPort(join(baseDir, "does-not-exist")),
      PREVIEW_PORT_AUTO,
    );
  } finally {
    removeProject(join(baseDir, "corrupt-field-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// Old manifests (no previewPort) load unchanged as auto: createProject must not
// bloat the manifest with a redundant "auto", and openProject must still work.
Deno.test("previewPort: new manifest omits the field, defaults to auto (A2)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-preview-default-",
  });
  try {
    const entry = createProject(baseDir, "Default Auto App");
    const manifest = JSON.parse(
      readFileSync(getProjectPaths(entry.path).manifest, "utf-8"),
    );
    assertEquals("previewPort" in manifest, false);
    assertEquals(readProjectPreviewPort(entry.path), PREVIEW_PORT_AUTO);
    // openProject still surfaces the classic ProjectEntry shape unchanged.
    const reopened = openProject(entry.path);
    assertEquals(reopened.name, "Default Auto App");
  } finally {
    removeProject(join(baseDir, "default-auto-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// resolvePreviewPort precedence: fixed manifest > --app-port flag > auto.
Deno.test("resolvePreviewPort encodes fixed > flag > auto precedence (A2)", () => {
  // Fixed manifest beats a flag.
  assertEquals(resolvePreviewPort(3005, 4000), 3005);
  // Flag used when the manifest is auto.
  assertEquals(resolvePreviewPort(PREVIEW_PORT_AUTO, 4000), 4000);
  // Auto when both are absent.
  assertEquals(
    resolvePreviewPort(PREVIEW_PORT_AUTO, undefined),
    APP_PORT_AUTO,
  );
  // A fixed manifest port passes through unchanged even with no flag.
  assertEquals(resolvePreviewPort(3005, undefined), 3005);
});

// --- Source-backed run config (project import, Slice 3) ---

Deno.test("runConfig: absent field reads null; write/read round-trips (Slice 3)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-runconfig-roundtrip-",
  });
  try {
    const entry = createProject(baseDir, "Run Config App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // A fresh manifest has no sourceRun and reads back as null (auto-detect).
    assertEquals(readProjectRunConfig(entry.path), null);

    // Command-only round-trips (cwd/port omitted, not written).
    const cmdOnly = writeProjectRunConfig(entry.path, {
      command: "npm run dev",
    });
    assertEquals(cmdOnly.ok, true);
    assertEquals(readProjectRunConfig(entry.path), { command: "npm run dev" });

    // Full config round-trips.
    const full = writeProjectRunConfig(entry.path, {
      command: "deno task dev",
      cwd: "/tmp/app",
      port: 5199,
    });
    assertEquals(full.ok, true);
    assertEquals(readProjectRunConfig(entry.path), {
      command: "deno task dev",
      cwd: "/tmp/app",
      port: 5199,
    });
    assertEquals(existsSync(`${manifestPath}.tmp`), false);
  } finally {
    removeProject(join(baseDir, "run-config-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("runConfig: write preserves other manifest keys (Slice 3)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-runconfig-preserve-",
  });
  try {
    const entry = createProject(baseDir, "Run Keep App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    const before = JSON.parse(readFileSync(manifestPath, "utf-8"));
    before.previewPort = 4321;
    before.futureField = { nested: true };
    writeFileSync(manifestPath, JSON.stringify(before, null, 2));

    const result = writeProjectRunConfig(entry.path, {
      command: "npm run dev",
    });
    assertEquals(result.ok, true);

    const after = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assertEquals(after.name, "Run Keep App");
    assertEquals(after.previewPort, 4321);
    assertEquals(after.futureField, { nested: true });
    assertEquals(after.sourceRun, { command: "npm run dev" });
    // The mode key set by createProject survives too.
    assertEquals(after.mode, DEFAULT_PROJECT_MODE);
  } finally {
    removeProject(join(baseDir, "run-keep-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("runConfig: invalid config rejected, manifest untouched (Slice 3)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-runconfig-invalid-",
  });
  try {
    const entry = createProject(baseDir, "Run Invalid App");
    const manifestPath = getProjectPaths(entry.path).manifest;
    const before = readFileSync(manifestPath, "utf-8");

    // Empty command is rejected.
    const empty = writeProjectRunConfig(entry.path, { command: "  " });
    assertEquals(empty.ok, false);
    if (!empty.ok) assertEquals(empty.error.code, "INVALID_RUN_CONFIG");

    // Out-of-range port is rejected.
    const badPort = writeProjectRunConfig(entry.path, {
      command: "npm run dev",
      port: 70000,
    });
    assertEquals(badPort.ok, false);

    // Manifest is byte-for-byte unchanged, and reads back as null.
    assertEquals(readFileSync(manifestPath, "utf-8"), before);
    assertEquals(readProjectRunConfig(entry.path), null);
  } finally {
    removeProject(join(baseDir, "run-invalid-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});

Deno.test("runConfig: corrupt/ill-typed field reads back as null (Slice 3)", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-runconfig-corrupt-",
  });
  try {
    const entry = createProject(baseDir, "Run Corrupt App");
    const manifestPath = getProjectPaths(entry.path).manifest;

    // sourceRun with a non-string command is ignored.
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    parsed.sourceRun = { command: 123, port: "nope" };
    writeFileSync(manifestPath, JSON.stringify(parsed, null, 2));
    assertEquals(readProjectRunConfig(entry.path), null);

    // Broken JSON reads back as null too.
    writeFileSync(manifestPath, "{ broken json");
    assertEquals(readProjectRunConfig(entry.path), null);
  } finally {
    removeProject(join(baseDir, "run-corrupt-app"));
    rmSync(baseDir, { recursive: true, force: true });
  }
});
