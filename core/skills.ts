import { eq } from "drizzle-orm";
import { genieSkillsTable } from "./db/schema/index.ts";
import type { DrizzleDb } from "./db/factory.ts";

export interface Skill {
  id: number;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = typeof genieSkillsTable.$inferSelect;

function rowToSkill(r: Row): Skill {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class SkillManager {
  constructor(private db: DrizzleDb) {}

  async create(
    name: string,
    description: string,
    prompt: string,
  ): Promise<Skill> {
    const now = new Date().toISOString();
    const rows = await this.db
      .insert(genieSkillsTable)
      .values({
        name,
        description,
        prompt,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToSkill(rows[0]!);
  }

  async update(
    id: number,
    fields: Partial<Pick<Skill, "name" | "description" | "prompt" | "enabled">>,
  ): Promise<Skill | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieSkillsTable)
      .set({
        name: fields.name ?? existing.name,
        description: fields.description ?? existing.description,
        prompt: fields.prompt ?? existing.prompt,
        enabled: fields.enabled ?? existing.enabled,
        updatedAt: now,
      })
      .where(eq(genieSkillsTable.id, id))
      .returning();
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .delete(genieSkillsTable)
      .where(eq(genieSkillsTable.id, id))
      .returning();
    return result.length > 0;
  }

  async get(id: number): Promise<Skill | null> {
    const rows = await this.db
      .select()
      .from(genieSkillsTable)
      .where(eq(genieSkillsTable.id, id))
      .limit(1);
    return rows[0] ? rowToSkill(rows[0]) : null;
  }

  async list(): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(genieSkillsTable)
      .orderBy(genieSkillsTable.name);
    return rows.map(rowToSkill);
  }

  async listEnabled(): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(genieSkillsTable)
      .where(eq(genieSkillsTable.enabled, true))
      .orderBy(genieSkillsTable.name);
    return rows.map(rowToSkill);
  }

  async getSkillsHash(): Promise<string> {
    const enabled = await this.listEnabled();
    return JSON.stringify(
      enabled.map((s) => ({ name: s.name, prompt: s.prompt })),
    );
  }
}
