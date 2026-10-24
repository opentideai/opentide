// @layer core — the changelog shape of an asset. Text assets carry their bytes
// inline (the IDE diffs them); binary assets carry a hash into the project's
// blob store, so undo can put the exact bytes back without bloating the log.
import { blobHash, readBlob, writeBlobIfMissing } from "../blob-store.ts";
import { isEditableTextAssetMime } from "../assets.ts";
import { getProjectPaths } from "../project-manager.ts";
import type { Kernel } from "../registries.ts";
import { encodeBase64 } from "../util.ts";

export interface AssetSnapshot {
  name: string;
  mimeType: string;
  size: number;
  module?: string;
  contentBase64?: string;
  contentHash?: string;
  [key: string]: unknown;
}

interface AssetBytes {
  name: string;
  content: Uint8Array;
  mimeType: string;
  module?: string;
}

function blobRoot(kernel: Kernel): string | null {
  return kernel.projectDir
    ? getProjectPaths(kernel.projectDir).assetBlobsDir
    : null;
}

// Binary bytes go to the blob store when the kernel has a project dir. Without
// one there is nowhere durable to put them, so the snapshot has no content and
// isn't restorable.
export function assetSnapshot(
  kernel: Kernel,
  asset: AssetBytes,
): AssetSnapshot {
  const base: AssetSnapshot = {
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.content.byteLength,
    ...(asset.module ? { module: asset.module } : {}),
  };
  if (isEditableTextAssetMime(asset.mimeType)) {
    return { ...base, contentBase64: encodeBase64(asset.content) };
  }
  const root = blobRoot(kernel);
  if (!root) return { ...base, contentBase64: "" };
  const contentHash = blobHash(asset.content);
  writeBlobIfMissing(root, contentHash, asset.content);
  return { ...base, contentHash };
}

export function assetSnapshotRestorable(
  snapshot: AssetSnapshot | null,
): boolean {
  if (!snapshot) return true;
  return !!snapshot.contentHash || !!snapshot.contentBase64;
}

export function assetSnapshotBytes(
  kernel: Kernel,
  snapshot: AssetSnapshot,
): Uint8Array | null {
  if (snapshot.contentHash) {
    const root = blobRoot(kernel);
    return root ? readBlob(root, snapshot.contentHash) : null;
  }
  if (!snapshot.contentBase64) return null;
  const binary = atob(snapshot.contentBase64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
