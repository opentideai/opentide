// @layer core — CustomAuditMap registry collection owned by the Kernel; NOT
// verification audit machinery.
import type { CustomAuditEntry } from "./types.ts";
import { createTimestampedId } from "./ids.ts";

export class CustomAuditMap {
  private audits = new Map<string, CustomAuditEntry>();

  register(
    name: string,
    description: string,
    prompt: string,
    module?: string,
    entityUid?: string,
  ): void {
    this.audits.set(name, {
      name,
      description,
      prompt,
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      // A2 (Stream A): mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.audits.get(name)?.entityUid ??
        createTimestampedId("ent"),
    });
  }

  get(name: string): CustomAuditEntry | undefined {
    return this.audits.get(name);
  }

  list(): CustomAuditEntry[] {
    return [...this.audits.values()];
  }

  remove(name: string): boolean {
    return this.audits.delete(name);
  }

  clear(): void {
    this.audits.clear();
  }

  serialize(): Array<
    {
      name: string;
      description: string;
      prompt: string;
      registeredAt: string;
      module?: string;
      entityUid: string;
    }
  > {
    return this.list().map((
      { name, description, prompt, registeredAt, module, entityUid },
    ) => ({
      name,
      description,
      prompt,
      registeredAt,
      ...(module ? { module } : {}),
      entityUid,
    }));
  }
}
