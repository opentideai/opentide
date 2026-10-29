import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeFileIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

// Copies a file and reads both back, so a move can delete the original only
// once the copy is known good.
export function copyVerified(from: string, to: string): void {
  ensureDir(dirname(to));
  copyFileSync(from, to);
  if (readFileSync(from, "utf-8") !== readFileSync(to, "utf-8")) {
    throw new Error(`Copy of ${from} to ${to} does not match the original`);
  }
}

// Changes whenever the file does: appends grow it, rewrites replace it by
// rename (a new inode), and either moves the mtime. Null when it's missing.
export function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJsonIfChanged(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const next = JSON.stringify(value, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf-8") === next) return;
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, next);
  renameSync(tmpPath, path);
}

export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as T);
}

export function appendJsonLine(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const line = JSON.stringify(value) + "\n";
  writeFileSync(path, line, { flag: "a" });
}

export function rewriteJsonLines(path: string, values: unknown[]): void {
  ensureDir(dirname(path));
  const next = values.map((value) => JSON.stringify(value)).join("\n") +
    (values.length > 0 ? "\n" : "");
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, next);
  renameSync(tmpPath, path);
}
