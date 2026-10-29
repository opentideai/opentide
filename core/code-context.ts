// @layer core — project source assembled as prompt context.
//
// One place builds the code an auditor or refuter reads: the whole project, the
// entities a changeset touched, or the code behind one claim. The closed agents
// use it in-process; get_code_context serves it to any MCP client.
import type { Kernel } from "./registries.ts";
import type { Changeset } from "./types.ts";
import {
  REFUTE_CONTEXT_MAX_CHARS,
  REFUTE_CONTEXT_MAX_ENTITIES,
} from "./config.ts";
import { resolveScopeSource } from "./fingerprint.ts";

export function buildCodeContext(kernel: Kernel): string {
  const sections: string[] = [];

  const routes = kernel.routes.list();
  if (routes.length > 0) {
    sections.push(
      "## Routes\n" + routes.map(
        (r) => `${r.method} ${r.path} → handler:${r.handlerName}`,
      ).join("\n"),
    );
  }

  const handlers = kernel.handlers.list();
  if (handlers.length > 0) {
    sections.push(
      "## Handlers\n" + handlers.map(
        (h) => `### handler:${h.name}\n\`\`\`typescript\n${h.source}\n\`\`\``,
      ).join("\n\n"),
    );
  }

  const functions = kernel.functions.list();
  if (functions.length > 0) {
    sections.push(
      "## Functions\n" + functions.map(
        (f) => `### function:${f.name}\n\`\`\`typescript\n${f.source}\n\`\`\``,
      ).join("\n\n"),
    );
  }

  const templates = kernel.templates.list();
  if (templates.length > 0) {
    sections.push(
      "## Templates\n" + templates.map(
        (t) => `### template:${t.name}\n\`\`\`html\n${t.content}\n\`\`\``,
      ).join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

// Fence language for a changed entity's source, by scope prefix. Templates are
// HTML; everything resolvable here is TypeScript.
const TEXT_ASSET_MAX_CHARS = 4_000;

function fenceLanguage(scope: string): string {
  if (scope.startsWith("template:")) return "html";
  if (scope.startsWith("asset:")) return "";
  if (scope.startsWith("config:")) return "json";
  if (scope.startsWith("sql:")) return "sql";
  return "typescript";
}

function capContext(text: string): string {
  if (text.length <= REFUTE_CONTEXT_MAX_CHARS) return text;
  return `${
    text.slice(0, REFUTE_CONTEXT_MAX_CHARS)
  }\n\n[refutation context truncated at ${REFUTE_CONTEXT_MAX_CHARS} characters]`;
}

function section(
  scope: string,
  body: string,
  language = fenceLanguage(scope),
): string {
  const fence = language ? `\`\`\`${language}` : "```";
  return `### ${scope}\n${fence}\n${body}\n\`\`\``;
}

function isTextAsset(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml");
}

// Resolve a "category:key" scope to the entity's current source. Extends
// resolveScopeSource (handlers + functions, the formal-spec surface) to templates,
// because a changeset that only touched markup still has code worth showing the
// refuter. Unresolvable scopes (assets, schemas, config) return null and are
// skipped — their content is not source the refuter can reason about.
function resolveChangedSource(kernel: Kernel, scope: string): string | null {
  if (scope.startsWith("template:")) {
    return kernel.templates.get(scope.slice("template:".length)) ?? null;
  }
  return resolveScopeSource(kernel, scope);
}

function resolveChangedScopeSection(
  kernel: Kernel,
  scope: string,
): string | null {
  const src = resolveChangedSource(kernel, scope);
  if (src !== null) return section(scope, src);

  const [kind, ...keyParts] = scope.split(":");
  const key = keyParts.join(":");
  if (!kind || !key) return null;

  switch (kind) {
    case "test": {
      const test = kernel.tests.get(key);
      return test ? section(scope, test.source, "typescript") : null;
    }
    case "asset": {
      const asset = kernel.assets.get(key);
      if (!asset) {
        return section(
          scope,
          `Asset "${key}" is not present in the current registry.`,
        );
      }
      const meta =
        `name: ${asset.name}\nmimeType: ${asset.mimeType}\nsize: ${asset.size} bytes`;
      if (!isTextAsset(asset.mimeType) || asset.size > TEXT_ASSET_MAX_CHARS) {
        return section(
          scope,
          `${meta}\ncontent: omitted (${
            isTextAsset(asset.mimeType)
              ? "oversized text asset"
              : "binary asset"
          })`,
          "",
        );
      }
      const content = new TextDecoder().decode(asset.content);
      const capped = content.length > TEXT_ASSET_MAX_CHARS
        ? `${
          content.slice(0, TEXT_ASSET_MAX_CHARS)
        }\n[asset content truncated at ${TEXT_ASSET_MAX_CHARS} characters]`
        : content;
      return section(scope, `${meta}\n\n${capped}`, "");
    }
    case "route": {
      const [method, ...pathParts] = key.split(" ");
      const route = method && pathParts.length > 0
        ? kernel.routes.get(method, pathParts.join(" "))
        : undefined;
      return section(
        scope,
        route
          ? JSON.stringify(
            {
              method: route.method,
              path: route.path,
              handlerName: route.handlerName,
              schema: route.schema ?? null,
            },
            null,
            2,
          )
          : `Route "${key}" is not present in the current registry.`,
        route ? "json" : "",
      );
    }
    case "config": {
      const entry = kernel.configs.getEntry(key);
      return section(
        scope,
        entry
          ? JSON.stringify(
            {
              name: entry.name,
              value: entry.value,
              description: entry.description ?? null,
            },
            null,
            2,
          )
          : `Config "${key}" is not present in the current registry.`,
        entry ? "json" : "",
      );
    }
    case "env_var": {
      return section(
        scope,
        JSON.stringify(
          {
            name: key,
            status: kernel.envVars.status(key),
            value: "[redacted]",
          },
          null,
          2,
        ),
        "json",
      );
    }
    case "sql":
      return section(scope, key, "sql");
    default:
      return null;
  }
}

// The source of the entities a changeset actually touched. This is the honest
// context for refuting a claim about that changeset: `buildCodeContext` inlines
// EVERY route, handler, function and template, and the refuter runs
// REFUTE_ATTEMPTS_DEFAULT times per claim — so the whole app was being shipped
// twice per claim to adjudicate a change that may have touched one entity.
// Returns "" when nothing resolves, which is the caller's signal to fall back.
export function buildChangedScopeContext(
  kernel: Kernel,
  scopes: readonly string[],
): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope)) continue;
    if (sections.length >= REFUTE_CONTEXT_MAX_ENTITIES) break;
    const resolved = resolveChangedScopeSection(kernel, scope);
    if (resolved === null) continue;
    seen.add(scope);
    sections.push(resolved);
  }
  return capContext(sections.join("\n\n"));
}

// The code most relevant to a claim, narrowest first: formal-spec target entities
// and tests that declare the claim, then the entities the changeset actually
// changed (`changedScopes`, supplied by the caller from the changelog), and only
// then the whole-project context. Each rung is a strictly broader guess at what
// the refuter needs, so the fallback is a last resort rather than the common case.
export function buildClaimContext(
  kernel: Kernel,
  changeset: Changeset,
  claimId: string,
  changedScopes?: readonly string[],
): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const spec of changeset.plan.formalSpecs ?? []) {
    if (!spec.claimIds.includes(claimId) || seen.has(spec.scope)) continue;
    const src = resolveScopeSource(kernel, spec.scope);
    if (src) {
      seen.add(spec.scope);
      sections.push(section(spec.scope, src, "typescript"));
    }
  }
  for (const t of kernel.tests.list()) {
    if (!t.verification?.claimIds?.includes(claimId)) continue;
    const key = `test:${t.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(section(`test:${t.name}`, t.source, "typescript"));
  }
  if (sections.length > 0) return capContext(sections.join("\n\n"));
  if (changedScopes?.length) {
    return buildChangedScopeContext(kernel, changedScopes);
  }
  return buildProjectContext(kernel);
}

// The whole project, capped: the last-resort context.
export function buildProjectContext(kernel: Kernel): string {
  return capContext(buildCodeContext(kernel));
}

// The entities a changeset touched, as "category:key" scopes, from its change
// records.
export async function changedScopesOf(
  kernel: Kernel,
  changesetId: string,
): Promise<string[]> {
  const records = await kernel.changelog.listByChangeset(changesetId);
  return [...new Set(records.map((r) => `${r.category}:${r.key}`))];
}
