export interface EnvLookup {
  get(name: string): string | undefined;
}

export interface EnvVarEntry {
  key: string;
  value?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export class EnvVarStore {
  private entries = new Map<string, EnvVarEntry>();
  private cache = new Map<string, string>();

  constructor(private envMap: EnvLookup) {}

  refreshCache(): void {
    this.cache.clear();
    for (const entry of this.entries.values()) {
      const value = entry.value ?? this.envMap.get(entry.key);
      if (value !== undefined) this.cache.set(entry.key, value);
    }
  }

  getCached(key: string): string | undefined {
    return this.cache.get(key);
  }

  cachedEntries(): Map<string, string> {
    return this.cache;
  }

  define(key: string, value?: string, description?: string): EnvVarEntry {
    const existing = this.entries.get(key);
    const now = new Date().toISOString();

    if (existing) {
      const newValue = value !== undefined ? value : existing.value;
      const newDesc = description !== undefined
        ? description
        : existing.description;
      const updated: EnvVarEntry = {
        key,
        value: newValue,
        description: newDesc,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      this.entries.set(key, updated);
      this.refreshCache();
      return updated;
    }

    const entry: EnvVarEntry = {
      key,
      value,
      description,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(key, entry);
    this.refreshCache();
    return entry;
  }

  get(key: string): EnvVarEntry | undefined {
    return this.entries.get(key);
  }

  list(): EnvVarEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.key.localeCompare(b.key)
    );
  }

  remove(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) this.refreshCache();
    return deleted;
  }

  setValue(key: string, value: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.value = value;
    entry.updatedAt = new Date().toISOString();
    this.refreshCache();
    return true;
  }

  clearValue(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.value = undefined;
    entry.updatedAt = new Date().toISOString();
    this.refreshCache();
    return true;
  }

  resolve(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry?.value !== undefined) return entry.value;
    return this.envMap.get(key);
  }

  resolveAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of this.entries.values()) {
      const value = entry.value ?? this.envMap.get(entry.key);
      if (value !== undefined) result[entry.key] = value;
    }
    return result;
  }

  status(key: string): "set" | "env" | "unset" {
    const entry = this.entries.get(key);
    if (!entry) return "unset";
    if (entry.value !== undefined) return "set";
    if (this.envMap.get(key) !== undefined) return "env";
    return "unset";
  }

  listEnriched(): Array<
    {
      key: string;
      value: string | undefined;
      description: string | undefined;
      resolvedValue: string | undefined;
      status: "set" | "env" | "unset";
      createdAt: string;
      updatedAt: string;
    }
  > {
    return this.list().map((e) => {
      const resolvedValue = e.value ?? this.envMap.get(e.key);
      const status: "set" | "env" | "unset" = e.value !== undefined
        ? "set"
        : this.envMap.get(e.key) !== undefined
        ? "env"
        : "unset";
      return {
        key: e.key,
        value: e.value,
        description: e.description,
        resolvedValue,
        status,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
    });
  }

  serialize(): Array<
    {
      key: string;
      value?: string;
      description?: string;
      createdAt: string;
      updatedAt: string;
    }
  > {
    return this.list().map((
      { key, value, description, createdAt, updatedAt },
    ) => ({
      key,
      ...(value !== undefined ? { value } : {}),
      ...(description ? { description } : {}),
      createdAt,
      updatedAt,
    }));
  }

  restore(
    entries: Array<
      {
        key: string;
        value?: string;
        description?: string;
        createdAt: string;
        updatedAt: string;
      }
    >,
  ): void {
    this.entries.clear();
    for (const e of entries) {
      this.entries.set(e.key, e);
    }
    this.refreshCache();
  }
}
