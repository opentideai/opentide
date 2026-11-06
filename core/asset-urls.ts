// Cache-busting for asset links in templates: every `/_assets/<name>` gets
// `?v=<version>`, so a re-uploaded asset is fetched fresh. Imports nothing, so
// the runner can use it as well as the kernel.

const ASSET_URL_RE = /(\/_assets\/)([^"'?\s#]+)(\?v=[^"'\s#]*)?/g;

export function stampAssetVersions(
  content: string,
  assetVersion: (name: string) => string | undefined,
): string {
  return content.replace(
    ASSET_URL_RE,
    (match, prefix: string, assetName: string) => {
      const v = assetVersion(assetName);
      return v ? `${prefix}${assetName}?v=${v}` : match;
    },
  );
}

// The version an asset is stamped with: when it was registered, in ms.
export function assetVersionOf(registeredAt: string): string {
  return String(new Date(registeredAt).getTime());
}
