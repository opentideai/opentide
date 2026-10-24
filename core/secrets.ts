import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getTideDir } from "./config.ts";

export interface SecretEntry {
  key: string;
  description?: string;
  value?: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretsFile {
  version: 1;
  secrets: SecretEntry[];
}

const SECRETS_DIR = join(getTideDir(), "secrets");

function ensureDir(): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true });
  }
}

function projectId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export class SecretsStore {
  private secrets = new Map<string, SecretEntry>();
  private filePath: string | null = null;

  load(projectPath: string): void {
    ensureDir();
    this.filePath = join(SECRETS_DIR, `${projectId(projectPath)}.json`);
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(
        readFileSync(this.filePath, "utf-8"),
      ) as SecretsFile;
      for (const s of data.secrets) {
        this.secrets.set(s.key, s);
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  define(key: string, description?: string): SecretEntry {
    const existing = this.secrets.get(key);
    const now = new Date().toISOString();
    const entry: SecretEntry = {
      key,
      description: description ?? existing?.description,
      value: existing?.value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.secrets.set(key, entry);
    this.persist();
    return entry;
  }

  get(key: string): SecretEntry | undefined {
    return this.secrets.get(key);
  }

  list(): SecretEntry[] {
    return Array.from(this.secrets.values());
  }

  remove(key: string): boolean {
    if (!this.secrets.has(key)) return false;
    this.secrets.delete(key);
    this.persist();
    return true;
  }

  setValue(key: string, value: string): boolean {
    const entry = this.secrets.get(key);
    if (!entry) return false;
    entry.value = value;
    entry.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  clearValue(key: string): boolean {
    const entry = this.secrets.get(key);
    if (!entry) return false;
    delete entry.value;
    entry.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  resolve(key: string): string | undefined {
    const entry = this.secrets.get(key);
    if (!entry) return undefined;
    if (entry.value !== undefined) return entry.value;
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  }

  resolveAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of this.secrets.values()) {
      const resolved = this.resolve(entry.key);
      if (resolved !== undefined) result[entry.key] = resolved;
    }
    return result;
  }

  status(key: string): "set" | "env" | "unset" {
    const entry = this.secrets.get(key);
    if (!entry) return "unset";
    if (entry.value !== undefined) return "set";
    try {
      if (Deno.env.get(key) !== undefined) return "env";
    } catch {
      // Deno.env not available
    }
    return "unset";
  }

  static deleteProjectSecrets(projectPath: string): boolean {
    const filePath = join(SECRETS_DIR, `${projectId(projectPath)}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }

  static hasProjectSecrets(projectPath: string): boolean {
    const filePath = join(SECRETS_DIR, `${projectId(projectPath)}.json`);
    return existsSync(filePath);
  }

  // A task fork gets its own copy, so a secret set in the fork stays there.
  static copyProjectSecrets(
    fromProjectPath: string,
    toProjectPath: string,
  ): boolean {
    ensureDir();
    const fromFilePath = join(
      SECRETS_DIR,
      `${projectId(fromProjectPath)}.json`,
    );
    const toFilePath = join(SECRETS_DIR, `${projectId(toProjectPath)}.json`);
    if (fromFilePath === toFilePath || !existsSync(fromFilePath)) return false;
    copyFileSync(fromFilePath, toFilePath);
    return true;
  }

  static moveProjectSecrets(
    oldProjectPath: string,
    newProjectPath: string,
  ): boolean {
    ensureDir();
    const oldFilePath = join(SECRETS_DIR, `${projectId(oldProjectPath)}.json`);
    const newFilePath = join(SECRETS_DIR, `${projectId(newProjectPath)}.json`);
    if (oldFilePath === newFilePath || !existsSync(oldFilePath)) return false;
    if (existsSync(newFilePath)) {
      throw new Error(
        `Secrets already exist for project path: ${newProjectPath}`,
      );
    }
    renameSync(oldFilePath, newFilePath);
    return true;
  }

  private persist(): void {
    if (!this.filePath) return;
    ensureDir();
    const data: SecretsFile = {
      version: 1,
      secrets: Array.from(this.secrets.values()),
    };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
