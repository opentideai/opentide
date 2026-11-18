// Load a module the first time it's needed, and not before.
//
// `await import("./x.ts")` is not enough for that. Deno builds its module graph
// at startup from every import whose path is a literal, dynamic ones included,
// and keeps what it read even if the import never runs: a literal import of the
// tool registry costs an idle `opentide mcp` about 27MB. A path built at runtime
// is invisible to that pass, so the module is read only when this runs.
//
// Callers name the module twice, once as the path and once in the type
// (`importLater<typeof import("./x.ts")>("./x.ts", import.meta.url)`). The type
// is erased and costs nothing at runtime.
//
// Don't use it for anything a `deno compile` binary has to carry: the compiler
// can't see these imports either.
export function importLater<T>(path: string, from: string): Promise<T> {
  return import(new URL(path, from).href);
}
