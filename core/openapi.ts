import type { RouteEntry } from "./types.ts";

export interface OpenAPIOptions {
  title?: string;
  version?: string;
  serverUrl?: string;
}

export function generateOpenAPISpec(
  routes: RouteEntry[],
  options?: OpenAPIOptions,
): Record<string, unknown> {
  const title = options?.title ?? "OpenTide App";
  const version = options?.version ?? "1.0.0";
  const serverUrl = options?.serverUrl ?? "http://localhost:3001";

  const tagSet = new Set<string>();
  for (const r of routes) {
    for (const tag of r.schema?.tags ?? []) tagSet.add(tag);
  }

  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const openApiPath = routePathToOpenAPI(route.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const operation: Record<string, unknown> = {
      summary: route.schema?.summary ?? `${route.method} ${route.path}`,
      tags: route.schema?.tags ?? [deriveTag(route.path)],
      operationId: `${route.method.toLowerCase()}_${route.handlerName}`,
    };

    if (route.schema?.description) {
      operation.description = route.schema.description;
    }

    const parameters: unknown[] = [];

    if (route.schema?.params) {
      for (const [name, def] of Object.entries(route.schema.params)) {
        parameters.push({
          name,
          in: "path",
          required: true,
          schema: {
            type: def.type,
            ...(def.enum ? { enum: def.enum } : {}),
            ...(def.format ? { format: def.format } : {}),
          },
          ...(def.description ? { description: def.description } : {}),
        });
      }
    } else {
      for (const m of route.path.matchAll(/:(\w+)/g)) {
        parameters.push({
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    if (route.schema?.query) {
      for (const [name, def] of Object.entries(route.schema.query)) {
        parameters.push({
          name,
          in: "query",
          required: def.required ?? false,
          schema: {
            type: def.type,
            ...(def.enum ? { enum: def.enum } : {}),
            ...(def.format ? { format: def.format } : {}),
          },
          ...(def.description ? { description: def.description } : {}),
        });
      }
    }

    if (parameters.length) operation.parameters = parameters;

    if (route.schema?.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: route.schema.body } },
      };
    }

    if (route.schema?.responses) {
      const responses: Record<string, unknown> = {};
      for (const [status, resp] of Object.entries(route.schema.responses)) {
        responses[status] = {
          description: resp.description,
          ...(resp.schema
            ? { content: { "application/json": { schema: resp.schema } } }
            : {}),
        };
      }
      operation.responses = responses;
    } else {
      operation.responses = { "200": { description: "Success" } };
    }

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.0.3",
    info: { title, version },
    servers: [{ url: serverUrl }],
    tags: [...tagSet].map((t) => ({ name: t })),
    paths,
  };
}

// The kernel's route DSL (`/users/:id`) in OpenAPI's spelling (`/users/{id}`).
// `:param` is our own path syntax, not a framework's — see register_route's schema.
function routePathToOpenAPI(path: string): string {
  return path.replace(/:(\w+)/g, "{$1}");
}

function deriveTag(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1]) return parts[1];
  return parts[0] ?? "default";
}
