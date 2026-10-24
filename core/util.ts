export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

// Escape a string for safe use inside a RegExp.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip kernel-injected context blocks (referenced entities, attachments, work
// items) from a stored message so only the user/assistant prose remains.
export function stripModelContextContent(content: string): string {
  return content
    .replace(/\n\n<referenced-entities>[\s\S]*?<\/referenced-entities>/g, "")
    .replace(/\n?\n?<attachments>[\s\S]*?<\/attachments>/g, "")
    .replace(/\n*<genie-work-item>[\s\S]*?<\/genie-work-item>\s*/g, "")
    .trim();
}

// Base64-encode bytes in chunks to avoid "too many arguments" from spreading a
// large Uint8Array into String.fromCharCode.
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1024) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 1024));
  }
  return btoa(binary);
}

// Decode a base64 string to its raw bytes. The binary inverse of encodeBase64
// (decodeBase64Utf8 is a thin text wrapper over this).
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
