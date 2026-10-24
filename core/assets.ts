const EDITABLE_TEXT_ASSET_MIME_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/svg+xml",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
]);

export function isEditableTextAssetMime(mimeType: string): boolean {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  return mime.startsWith("text/") || EDITABLE_TEXT_ASSET_MIME_TYPES.has(mime);
}
