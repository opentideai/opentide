import type { Kernel } from "./registries.ts";

export interface Branch {
  name: string;
  snapshotId: string;
  createdAt: string;
}

export class BranchManager {
  private branches = new Map<string, Branch>();
  private active: string | null = null;

  async create(name: string, kernel: Kernel): Promise<Branch> {
    const snapshot = await kernel.snapshots.save(kernel, `branch: ${name}`);
    kernel.snapshots.pinForBranch(snapshot.id);
    const branch: Branch = {
      name,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
    };
    this.branches.set(name, branch);
    this.active = name;
    return branch;
  }

  async switch(
    name: string,
    kernel: Kernel,
    rebuild: () => void,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const target = this.branches.get(name);
    if (!target) return { ok: false, error: `Branch "${name}" not found.` };

    await this.saveActive(kernel);

    const result = await kernel.snapshots.restore(
      target.snapshotId,
      kernel,
      rebuild,
    );
    if (!result.ok) return { ok: false, error: result.error };

    this.active = name;
    return { ok: true };
  }

  list(): Branch[] {
    return [...this.branches.values()];
  }

  delete(name: string, kernel: Kernel): boolean {
    const branch = this.branches.get(name);
    if (!branch) return false;
    if (this.active === name) this.active = null;
    kernel.snapshots.unpinBranch(branch.snapshotId);
    kernel.snapshots.delete(branch.snapshotId);
    return this.branches.delete(name);
  }

  async saveActive(kernel: Kernel): Promise<void> {
    if (!this.active) return;
    const current = this.branches.get(this.active);
    if (!current) return;
    const oldId = current.snapshotId;
    const snap = await kernel.snapshots.save(
      kernel,
      `branch auto-save: ${this.active}`,
    );
    kernel.snapshots.pinForBranch(snap.id);
    if (oldId !== snap.id) kernel.snapshots.unpinBranch(oldId);
    current.snapshotId = snap.id;
  }

  getActive(): string | null {
    return this.active;
  }

  serialize(): Array<Branch & { isActive: boolean }> {
    return [...this.branches.values()].map((b) => ({
      ...b,
      isActive: b.name === this.active,
    }));
  }

  restore(entries: Array<Branch & { isActive?: boolean }>): void {
    this.branches.clear();
    this.active = null;
    for (const e of entries) {
      this.branches.set(e.name, {
        name: e.name,
        snapshotId: e.snapshotId,
        createdAt: e.createdAt,
      });
      if (e.isActive) this.active = e.name;
    }
  }
}
