import type { DevToolArgDef, DevToolEntry, DevToolFn } from "./types.ts";
import { createTimestampedId } from "./ids.ts";

export class DevToolMap {
  private tools = new Map<string, DevToolEntry>();

  register(
    name: string,
    description: string,
    args: DevToolArgDef[],
    source: string,
    fn: DevToolFn,
    module?: string,
    runtimeId?: string,
    language?: string,
    entityUid?: string,
  ): void {
    this.tools.set(name, {
      name,
      description,
      args,
      source,
      fn,
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      // A2 (Stream A): mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.tools.get(name)?.entityUid ??
        createTimestampedId("ent"),
    });
  }

  get(name: string): DevToolEntry | undefined {
    return this.tools.get(name);
  }

  list(): DevToolEntry[] {
    return [...this.tools.values()];
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  serialize(): Array<{
    name: string;
    description: string;
    args: DevToolArgDef[];
    source: string;
    registeredAt: string;
    module?: string;
    runtimeId?: string;
    language?: string;
    entityUid: string;
  }> {
    return this.list().map(({
      name,
      description,
      args,
      source,
      registeredAt,
      module,
      runtimeId,
      language,
      entityUid,
    }) => ({
      name,
      description,
      args,
      source,
      registeredAt,
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      entityUid,
    }));
  }
}
