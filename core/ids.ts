export function createTimestampedId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

export function createTimestampedShortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${
    crypto.randomUUID().slice(0, 8)
  }`;
}

export function createMergeableNumericId(existingIds: number[] = []): number {
  const now = Date.now() * 1000 +
    crypto.getRandomValues(new Uint16Array(1))[0]!;
  const maxExisting = existingIds.reduce((max, id) => Math.max(max, id), 0);
  return Math.max(now, maxExisting + 1);
}
