import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface DocEntry {
  topic: string;
  title: string;
  related: string[];
  content: string;
}

const GENERATED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "generated",
);
let cache: Map<string, DocEntry> | null = null;

function parseFrontmatter(
  raw: string,
): { meta: Record<string, string>; content: string } {
  if (!raw.startsWith("---")) return { meta: {}, content: raw };
  const end = raw.indexOf("---", 3);
  if (end === -1) return { meta: {}, content: raw };
  const lines = raw.slice(3, end).trim().split("\n");
  const meta: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { meta, content: raw.slice(end + 3).trim() };
}

function load(): Map<string, DocEntry> {
  if (cache) return cache;
  cache = new Map();
  for (const entry of Deno.readDirSync(GENERATED_DIR)) {
    if (!entry.name.endsWith(".md")) continue;
    const raw = Deno.readTextFileSync(join(GENERATED_DIR, entry.name));
    const { meta, content } = parseFrontmatter(raw);
    const topic = meta.topic || entry.name.replace(".md", "");
    cache.set(topic, {
      topic,
      title: meta.title || topic,
      related: meta.related ? meta.related.split(",").map((s) => s.trim()) : [],
      content,
    });
  }
  return cache;
}

export function getDoc(topic: string): DocEntry | undefined {
  return load().get(topic);
}

export function listTopics(): string[] {
  return [...load().keys()];
}
