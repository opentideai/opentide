import { assert, assertEquals } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadKernelState, saveKernelState } from "./persistence.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";

const TMP_DIR = join(Deno.cwd(), ".test_persistence_tmp");
const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "saveKernelState writes split deterministic state files",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state");
      kernel.configs.set("appName", "Test App");

      saveKernelState(kernel, stateDir);

      assert(existsSync(join(stateDir, "manifest.json")));
      assert(existsSync(join(stateDir, "configs.json")));
      assert(!existsSync(join(stateDir, "kernel-state.json")));
      const manifest = JSON.parse(
        readFileSync(join(stateDir, "manifest.json"), "utf-8"),
      );
      const configs = JSON.parse(
        readFileSync(join(stateDir, "configs.json"), "utf-8"),
      );
      assertEquals(manifest.version, 1);
      assertEquals(manifest.runtimeId, "typescript");
      assertEquals(configs[0].name, "appName");

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "loadKernelState defaults and round-trips source runtime metadata",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state-runtime");
      const source = "function answer() { return 42; }";
      kernel.functions.register(
        "answer",
        source,
        () => 42,
        undefined,
        undefined,
        kernel.runtimeId,
        kernel.runtime.defaultLanguage,
        "Return the answer to life, the universe, and everything.",
      );

      saveKernelState(kernel, stateDir);

      const functionState = JSON.parse(
        readFileSync(join(stateDir, "functions", "answer.json"), "utf-8"),
      );
      assertEquals(functionState.runtimeId, "typescript");
      assertEquals(functionState.language, "typescript");
      assertEquals(
        functionState.purpose,
        "Return the answer to life, the universe, and everything.",
      );

      const restoredDb = await Database.create({ driver: "pglite" });
      const restored = new Kernel(restoredDb);
      try {
        const result = await loadKernelState(restored, stateDir, () => {});
        assertEquals(result.errors, []);
        const entry = restored.functions.getEntry("answer");
        assertEquals(entry?.runtimeId, "typescript");
        assertEquals(entry?.language, "typescript");
        assertEquals(
          entry?.purpose,
          "Return the answer to life, the universe, and everything.",
        );
        assertEquals(restored.functions.call("answer"), 42);
      } finally {
        await restoredDb.close();
      }

      const manifestPath = join(stateDir, "manifest.json");
      const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      delete legacyManifest.runtimeId;
      writeFileSync(
        manifestPath,
        JSON.stringify(legacyManifest, null, 2) + "\n",
      );
      delete functionState.runtimeId;
      delete functionState.language;
      writeFileSync(
        join(stateDir, "functions", "answer.json"),
        JSON.stringify(functionState, null, 2) + "\n",
      );

      const legacyDb = await Database.create({ driver: "pglite" });
      const legacy = new Kernel(legacyDb);
      try {
        const result = await loadKernelState(legacy, stateDir, () => {});
        assertEquals(result.errors, []);
        const entry = legacy.functions.getEntry("answer");
        assertEquals(entry?.runtimeId, "typescript");
        assertEquals(entry?.language, "typescript");
      } finally {
        await legacyDb.close();
      }

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "entity revision survives a save/load round-trip (Stage 5)",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state-revision");
      // Two registrations ⇒ the registry bumps the revision to 2 (monotonic).
      kernel.functions.register(
        "answer",
        "function answer() { return 1; }",
        () => 1,
      );
      kernel.functions.register(
        "answer",
        "function answer() { return 2; }",
        () => 2,
      );
      assertEquals(kernel.functions.getEntry("answer")?.revision, 2);

      saveKernelState(kernel, stateDir);
      const persisted = JSON.parse(
        readFileSync(join(stateDir, "functions", "answer.json"), "utf-8"),
      );
      assertEquals(persisted.revision, 2);

      // A reload restores the counter, not resets it — the next write bumps from 2.
      const restoredDb = await Database.create({ driver: "pglite" });
      const restored = new Kernel(restoredDb);
      try {
        const result = await loadKernelState(restored, stateDir, () => {});
        assertEquals(result.errors, []);
        assertEquals(restored.functions.getEntry("answer")?.revision, 2);
        restored.functions.register(
          "answer",
          "function answer() { return 3; }",
          () => 3,
        );
        assertEquals(restored.functions.getEntry("answer")?.revision, 3);
      } finally {
        await restoredDb.close();
      }

      // Legacy state written before Stage 5 (no revision field) restores as a fresh 1.
      delete persisted.revision;
      writeFileSync(
        join(stateDir, "functions", "answer.json"),
        JSON.stringify(persisted, null, 2) + "\n",
      );
      const legacyDb = await Database.create({ driver: "pglite" });
      const legacy = new Kernel(legacyDb);
      try {
        await loadKernelState(legacy, stateDir, () => {});
        assertEquals(legacy.functions.getEntry("answer")?.revision, 1);
      } finally {
        await legacyDb.close();
      }

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "saveKernelState skips unchanged files",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state-stable");
      kernel.configs.set("appName", "Test App");

      saveKernelState(kernel, stateDir);
      const configsPath = join(stateDir, "configs.json");
      const mtime = statSync(configsPath).mtime?.getTime();
      saveKernelState(kernel, stateDir);
      assertEquals(statSync(configsPath).mtime?.getTime(), mtime);

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "saveKernelState isolates named entity changes",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state-entities");

      const firstSource = "function first() { return new Response('first'); }";
      const secondSource =
        "function second() { return new Response('second'); }";
      kernel.handlers.register(
        "first",
        firstSource,
        () => new Response("first"),
      );
      kernel.handlers.register(
        "second",
        secondSource,
        () => new Response("second"),
      );
      saveKernelState(kernel, stateDir);

      const routesPath = join(stateDir, "routes.json");
      const firstPath = join(stateDir, "handlers", "first.json");
      const secondPath = join(stateDir, "handlers", "second.json");
      const before = {
        routes: readFileSync(routesPath, "utf-8"),
        first: readFileSync(firstPath, "utf-8"),
        second: readFileSync(secondPath, "utf-8"),
      };

      kernel.handlers.register(
        "first",
        "function first() { return new Response('changed'); }",
        () => new Response("changed"),
      );
      saveKernelState(kernel, stateDir);

      assert(readFileSync(firstPath, "utf-8") !== before.first);
      assertEquals(readFileSync(secondPath, "utf-8"), before.second);
      assertEquals(readFileSync(routesPath, "utf-8"), before.routes);

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "loadKernelState handles corrupted split JSON gracefully",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state_corrupt");
      mkdirSync(stateDir, { recursive: true });

      writeFileSync(
        join(stateDir, "configs.json"),
        '{"version":1, "incomplete...',
      );

      const result = await loadKernelState(kernel, stateDir, () => {});
      assertEquals(result.errors.length, 1);
      assert(result.errors[0]!.includes("corrupted"));

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "loadKernelState returns empty errors for missing state dir",
  fn: async () => {
    await initCompiler();
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);

    const result = await loadKernelState(
      kernel,
      "/nonexistent/state-dir",
      () => {},
    );
    assertEquals(result.errors.length, 0);

    await db.close();
    stopCompiler();
  },
});

Deno.test({
  ...testOpts,
  name: "A2: entityUid is minted once, preserved across updates and reloads",
  fn: async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    try {
      await initCompiler();
      const db = await Database.create({ driver: "pglite" });
      const kernel = new Kernel(db);
      const stateDir = join(TMP_DIR, "state-entityuid");

      // Create then update the same handler: the uid is minted on create and
      // preserved verbatim across the update (unlike revision, which bumps).
      kernel.handlers.register(
        "greet",
        "function greet() { return new Response('hi'); }",
        () => new Response("hi"),
      );
      const created = kernel.handlers.get("greet")?.entityUid;
      assert(created && created.startsWith("ent_"));

      kernel.handlers.register(
        "greet",
        "function greet() { return new Response('hello'); }",
        () => new Response("hello"),
      );
      assertEquals(kernel.handlers.get("greet")?.entityUid, created);

      saveKernelState(kernel, stateDir);
      const persisted = JSON.parse(
        readFileSync(join(stateDir, "handlers", "greet.json"), "utf-8"),
      );
      assertEquals(persisted.entityUid, created);

      // A reload preserves the uid; a subsequent update still keeps it.
      const restoredDb = await Database.create({ driver: "pglite" });
      const restored = new Kernel(restoredDb);
      try {
        const result = await loadKernelState(restored, stateDir, () => {});
        assertEquals(result.errors, []);
        assertEquals(restored.handlers.get("greet")?.entityUid, created);
        restored.handlers.register(
          "greet",
          "function greet() { return new Response('hey'); }",
          () => new Response("hey"),
        );
        assertEquals(restored.handlers.get("greet")?.entityUid, created);
      } finally {
        await restoredDb.close();
      }

      // Pre-A2 state (no entityUid field) mints a fresh, stable uid on first
      // load — the migration. It is unknowable in advance, only that it persists.
      delete persisted.entityUid;
      writeFileSync(
        join(stateDir, "handlers", "greet.json"),
        JSON.stringify(persisted, null, 2) + "\n",
      );
      const legacyDb = await Database.create({ driver: "pglite" });
      const legacy = new Kernel(legacyDb);
      try {
        await loadKernelState(legacy, stateDir, () => {});
        const migrated = legacy.handlers.get("greet")?.entityUid;
        assert(migrated && migrated.startsWith("ent_"));
        // Persist the migrated uid, reload, and confirm it is now stable.
        const legacyState = join(TMP_DIR, "state-entityuid-migrated");
        saveKernelState(legacy, legacyState);
        const reDb = await Database.create({ driver: "pglite" });
        const re = new Kernel(reDb);
        try {
          await loadKernelState(re, legacyState, () => {});
          assertEquals(re.handlers.get("greet")?.entityUid, migrated);
        } finally {
          await reDb.close();
        }
      } finally {
        await legacyDb.close();
      }

      await db.close();
      stopCompiler();
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  },
});
