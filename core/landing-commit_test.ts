import { assert, assertEquals } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { COMMIT_ON_COMPLETE_DEFAULT, PROJECT_GITIGNORE } from "./config.ts";
import { commitLandedChangeset, commitManagedPaths } from "./landing-commit.ts";
import { getProjectPaths } from "./project-manager.ts";
import type { Changeset } from "./types.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function git(dir: string, ...args: string[]): string {
  const out = new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Tide Test",
      "-c",
      "user.email=tide-test@example.com",
      ...args,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

function write(dir: string, path: string, content = path): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function withProject(
  fn: (dir: string, kernel: Kernel) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-landing-",
  });
  const db = await Database.create({ driver: "pglite" });
  // git identity for the commits the code under test makes.
  const env = {
    GIT_AUTHOR_NAME: "Tide Test",
    GIT_AUTHOR_EMAIL: "tide-test@example.com",
    GIT_COMMITTER_NAME: "Tide Test",
    GIT_COMMITTER_EMAIL: "tide-test@example.com",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  try {
    write(
      dir,
      "opentide.json",
      JSON.stringify({ name: "Landing", commitOnComplete: true }),
    );
    const kernel = new Kernel(db, {
      historyDir: getProjectPaths(dir).historyDir,
    });
    kernel.projectDir = dir;
    await fn(dir, kernel);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function changeset(id: string, title: string): Changeset {
  return { id, title } as Changeset;
}

async function recordFileWrite(
  kernel: Kernel,
  changesetId: string,
  key: string,
): Promise<void> {
  await kernel.changelog.record({
    category: "module",
    key,
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { path: key, content: key },
    context: { changesetId, sourceBacked: true, projectFile: true },
  });
}

Deno.test({
  ...testOpts,
  name: "a landing commit takes OpenTide's files and leaves the user's alone",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      git(dir, "init", "-q");
      write(dir, "user.txt", "v1");
      git(dir, "add", "user.txt");
      git(dir, "commit", "-q", "-m", "user's own");

      // The user's work in progress: modified, staged, and untracked.
      write(dir, "user.txt", "v2");
      write(dir, "staged.txt");
      git(dir, "add", "staged.txt");
      write(dir, "notes.txt");

      // OpenTide's: app state, history, a project file the changeset wrote,
      // and machine-local files no .gitignore covers in this repo.
      write(dir, ".opentide/state/handlers/hello.json");
      write(dir, "src/app.ts");
      await recordFileWrite(kernel, "cs1", "src/app.ts");
      write(dir, ".opentide/history/usage/s1.jsonl");
      write(dir, ".opentide/history/model-usage.jsonl");
      write(dir, ".opentide/kernel.token", "secret");
      write(dir, "src/other.ts");
      await kernel.sessions.createSession("Mine", { visibility: "private" });

      const result = await commitLandedChangeset(
        kernel,
        changeset("cs1", "Add hello"),
      );
      assert(result.committed, JSON.stringify(result));

      const committed = lines(
        git(dir, "show", "--name-only", "--format=", "HEAD"),
      );
      assert(committed.includes(".opentide/state/handlers/hello.json"));
      assert(committed.includes("src/app.ts"));
      assert(committed.includes("opentide.json"));
      assert(committed.some((path) => path.startsWith(".opentide/history/")));
      for (const path of committed) {
        assert(
          !["user.txt", "staged.txt", "notes.txt", "src/other.ts"].includes(
            path,
          ),
          `${path} is the user's`,
        );
        assert(!path.includes("/usage/"), path);
        assert(!path.endsWith("model-usage.jsonl"), path);
        assert(!path.includes("kernel.token"), path);
        assert(!path.includes("/private/"), path);
      }
      assertEquals(
        lines(git(dir, "log", "-1", "--format=%s%n%b"))[0],
        "Add hello",
      );

      // The user's index and working tree are as they left them.
      assertEquals(lines(git(dir, "diff", "--cached", "--name-only")), [
        "staged.txt",
      ]);
      assertEquals(lines(git(dir, "diff", "--name-only")), ["user.txt"]);

      // Nothing new of OpenTide's: nothing to commit.
      const again = await commitLandedChangeset(
        kernel,
        changeset("cs1", "Add hello"),
      );
      assertEquals(again, { committed: false, reason: "nothing_to_commit" });
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "a landing commit works when the project's .gitignore lists the machine-local files",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      git(dir, "init", "-q");
      write(dir, ".gitignore", PROJECT_GITIGNORE);
      git(dir, "add", ".gitignore");
      git(dir, "commit", "-q", "-m", "scaffold");

      // What a live session leaves under history/: all of it ignored.
      write(dir, ".opentide/history/usage/s1.jsonl");
      write(dir, ".opentide/history/model-usage.jsonl");
      write(dir, ".opentide/history/cursor.json");
      write(dir, ".opentide/history/episodes.jsonl");
      write(dir, ".opentide/history/private/sessions/s2.json");
      write(dir, ".opentide/history/sessions/s1.json");
      write(dir, ".opentide/state/handlers/hello.json");

      const result = await commitLandedChangeset(
        kernel,
        changeset("cs1", "Add hello"),
      );
      assert(result.committed, JSON.stringify(result));
      const committed = lines(
        git(dir, "show", "--name-only", "--format=", "HEAD"),
      );
      assert(committed.includes(".opentide/history/sessions/s1.json"));
      assert(committed.includes(".opentide/state/handlers/hello.json"));
      for (const path of committed) {
        assert(
          !path.includes("usage") && !path.includes("cursor") &&
            !path.includes("episodes") && !path.includes("private"),
          `${path} is machine-local`,
        );
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a project with no repo gets one on its first landing",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      write(dir, ".opentide/state/handlers/hello.json");
      const result = await commitLandedChangeset(
        kernel,
        changeset("cs1", "First"),
      );
      assert(result.committed, JSON.stringify(result));
      assertEquals(lines(git(dir, "log", "--format=%s")), ["First"]);
      assert(
        lines(git(dir, "show", "--name-only", "--format=", "HEAD"))
          .includes(".gitignore"),
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "commitOnComplete false turns landing commits off",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      git(dir, "init", "-q");
      write(
        dir,
        "opentide.json",
        JSON.stringify({ name: "Landing", commitOnComplete: false }),
      );
      write(dir, ".opentide/state/handlers/hello.json");
      const result = await commitLandedChangeset(
        kernel,
        changeset("cs1", "Nope"),
      );
      assertEquals(result, { committed: false, reason: "off" });
      assertEquals(
        new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir })
          .outputSync().success,
        false,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "without commitOnComplete, landing commits follow the default",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      git(dir, "init", "-q");
      write(dir, "opentide.json", JSON.stringify({ name: "Landing" }));
      write(dir, ".opentide/state/handlers/hello.json");
      const result = await commitLandedChangeset(
        kernel,
        changeset("cs1", "Default"),
      );
      if (COMMIT_ON_COMPLETE_DEFAULT) {
        assert(result.committed, JSON.stringify(result));
      } else {
        assertEquals(result, { committed: false, reason: "off" });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "checkpoints commit unless commitOnComplete is false",
  fn: async () => {
    await withProject(async (dir, kernel) => {
      git(dir, "init", "-q");
      write(dir, "opentide.json", JSON.stringify({ name: "Landing" }));
      write(dir, ".opentide/state/handlers/hello.json");
      assert(await commitManagedPaths(kernel, dir, "Step 1", null));
      write(
        dir,
        "opentide.json",
        JSON.stringify({ name: "Landing", commitOnComplete: false }),
      );
      write(dir, ".opentide/state/handlers/bye.json");
      assertEquals(await commitManagedPaths(kernel, dir, "Step 2", null), null);
    });
  },
});
