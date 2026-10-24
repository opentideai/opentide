import { existsSync, rmSync } from "node:fs";
import { readJsonFile, writeJsonIfChanged } from "./history-store.ts";

type LocalStateData = Record<string, unknown>;

export class LocalStateStore {
  constructor(private readonly path: string) {}

  get<T = unknown>(key: string): T | null {
    const data = readJsonFile<LocalStateData>(this.path) ?? {};
    return Object.hasOwn(data, key) ? data[key] as T : null;
  }

  set(key: string, value: unknown): void {
    const data = readJsonFile<LocalStateData>(this.path) ?? {};
    writeJsonIfChanged(this.path, { ...data, [key]: value });
  }

  delete(key: string): void {
    const data = readJsonFile<LocalStateData>(this.path) ?? {};
    if (!Object.hasOwn(data, key)) return;
    const { [key]: _removed, ...next } = data;
    if (Object.keys(next).length === 0) {
      if (existsSync(this.path)) rmSync(this.path, { force: true });
      return;
    }
    writeJsonIfChanged(this.path, next);
  }
}
