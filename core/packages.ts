import { errorMessage } from "./util.ts";

export interface PackageEntry {
  name: string;
  specifier: string;
  module: Record<string, unknown>;
  installedAt: string;
}

export type SerializedPackageEntry = Pick<
  PackageEntry,
  "name" | "specifier" | "installedAt"
>;

export class PackageMap {
  private packages = new Map<string, PackageEntry>();
  private _proxy: Record<string, unknown> | null = null;

  async install(name: string, version?: string): Promise<PackageEntry> {
    const specifier = version ? `npm:${name}@${version}` : `npm:${name}`;
    const module = await import(specifier) as Record<string, unknown>;
    const entry: PackageEntry = {
      name,
      specifier,
      module,
      installedAt: new Date().toISOString(),
    };
    this.packages.set(name, entry);
    return entry;
  }

  get(name: string): Record<string, unknown> | undefined {
    return this.packages.get(name)?.module;
  }

  getEntry(name: string): PackageEntry | undefined {
    return this.packages.get(name);
  }

  list(): SerializedPackageEntry[] {
    return [...this.packages.values()].map((
      { name, specifier, installedAt },
    ) => ({
      name,
      specifier,
      installedAt,
    }));
  }

  remove(name: string): boolean {
    return this.packages.delete(name);
  }

  clear(): void {
    this.packages.clear();
  }

  serialize(): SerializedPackageEntry[] {
    return this.list();
  }

  async restore(entries: SerializedPackageEntry[]): Promise<string[]> {
    this.packages.clear();
    const errors: string[] = [];
    for (const e of entries) {
      try {
        const module = await import(e.specifier) as Record<string, unknown>;
        this.packages.set(e.name, { ...e, module });
      } catch (err) {
        errors.push(
          `Failed to restore package "${e.name}": ${errorMessage(err)}`,
        );
      }
    }
    return errors;
  }

  proxy(): Record<string, unknown> {
    if (!this._proxy) {
      const packages = this.packages;
      this._proxy = new Proxy({} as Record<string, unknown>, {
        get(_, prop: string) {
          return packages.get(prop)?.module;
        },
        has(_, prop: string) {
          return packages.has(prop);
        },
        ownKeys() {
          return [...packages.keys()];
        },
        getOwnPropertyDescriptor(_, prop: string) {
          if (packages.has(prop)) {
            return {
              configurable: true,
              enumerable: true,
              value: packages.get(prop)?.module,
            };
          }
        },
      });
    }
    return this._proxy;
  }
}
