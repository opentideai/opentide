// @layer core — the toolsets a project gives a new MCP connection, read from its
// opentide.json. Apart from toolsets.ts so the guide and the tool catalog don't
// load the project manager.
import {
  PROJECT_MODE_SOURCE_BACKED,
  readProjectMode,
  readProjectToolsets,
} from "./project-manager.ts";
import {
  type ParsedToolsets,
  parseToolsetList,
  parseToolsets,
  SOURCE_TOOLSET,
} from "./tools/toolsets.ts";

// What a connection starts with: the toolsets it asked for (`requested`, from
// --tools or ?toolsets=), else the project's opentide.json `toolsets`, else core
// alone. A source-backed project adds `source` either way.
export function startingToolsets(
  projectDir: string | null,
  requested: string | null,
): ParsedToolsets {
  const parsed = requested !== null
    ? parseToolsetList(requested)
    : parseToolsets(projectDir ? readProjectToolsets(projectDir) ?? [] : []);
  if (
    projectDir && readProjectMode(projectDir) === PROJECT_MODE_SOURCE_BACKED
  ) {
    return {
      ...parsed,
      selection: new Set([...parsed.selection, SOURCE_TOOLSET]),
    };
  }
  return parsed;
}
