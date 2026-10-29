import { normalize, resolve } from "node:path";

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
