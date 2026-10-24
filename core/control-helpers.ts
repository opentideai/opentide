import { normalize, resolve } from "node:path";
import type { MCPServerConfig } from "./mcp.ts";

export function resolveProjectFilePath(
  root: string,
  rawPath: string,
): { fullPath: string; relativePath: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decoded) return null;
  const normalizedRoot = normalize(resolve(root));
  const fullPath = normalize(resolve(normalizedRoot, decoded));
  if (
    fullPath !== normalizedRoot && !fullPath.startsWith(normalizedRoot + "/")
  ) return null;
  return { fullPath, relativePath: decoded };
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type McpServerConfigInputResult =
  | { ok: true; config: MCPServerConfig }
  | { ok: false; error: string };

export function parseMcpServerConfigInput(
  body: Record<string, unknown>,
): McpServerConfigInputResult {
  const name = stringField(body, "name");
  const transport = body.transport;
  if (!name) return { ok: false, error: "name is required" };
  if (transport !== "url" && transport !== "stdio") {
    return { ok: false, error: "transport is required (url or stdio)" };
  }

  const url = typeof body.url === "string" ? body.url.trim() : undefined;
  const command = typeof body.command === "string"
    ? body.command.trim()
    : undefined;
  if (transport === "url" && !url) {
    return { ok: false, error: "url is required for url transport" };
  }
  if (transport === "stdio" && !command) {
    return { ok: false, error: "command is required for stdio transport" };
  }

  if (
    body.args !== undefined &&
    (!Array.isArray(body.args) ||
      !body.args.every((a) => typeof a === "string"))
  ) {
    return { ok: false, error: "args must be an array of strings" };
  }
  if (
    body.env !== undefined &&
    (!isRecord(body.env) ||
      !Object.values(body.env).every((v) => typeof v === "string"))
  ) {
    return { ok: false, error: "env must be an object of string values" };
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (body.authToken !== undefined && typeof body.authToken !== "string") {
    return { ok: false, error: "authToken must be a string" };
  }

  return {
    ok: true,
    config: {
      name,
      enabled: body.enabled !== false,
      transport,
      ...(transport === "url"
        ? {
          url: url!,
          authToken: typeof body.authToken === "string"
            ? body.authToken
            : undefined,
        }
        : {}),
      ...(transport === "stdio"
        ? {
          command: command!,
          args: body.args as string[] | undefined,
          env: body.env as Record<string, string> | undefined,
        }
        : {}),
    },
  };
}
