import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = ".env";

export function getEnvPath(projectDir: string): string {
  return join(projectDir, ENV_FILE);
}

export function loadEnv(projectDir: string): Record<string, string> {
  const envPath = getEnvPath(projectDir);
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf-8");
  return parseEnv(content);
}

export function saveEnv(
  projectDir: string,
  vars: Record<string, string>,
): void {
  const envPath = getEnvPath(projectDir);
  const lines = Object.entries(vars).map(([k, v]) => {
    if (v.includes("\n") || v.includes('"') || v.includes(" ")) {
      return `${k}="${
        v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
      }"`;
    }
    return `${k}=${v}`;
  });
  const tmp = envPath + ".tmp";
  // .env may hold secret-like values — keep it owner-only (matches secrets.ts).
  // rename preserves the temp file's mode, so the final .env is 0o600 too.
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, envPath);
}

function parseEnv(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    if (isDoubleQuoted) {
      value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(
        /\\\\/g,
        "\\",
      );
    } else if (value.includes("\\n")) {
      value = value.replace(/\\n/g, "\n");
    }
    vars[key] = value;
  }
  return vars;
}
