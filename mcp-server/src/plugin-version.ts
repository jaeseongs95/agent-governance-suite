export function parseStableVersion(version: string): [number, number, number] | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : null;
}

export function compareStableVersionNumbers(leftVersion: string, rightVersion: string): number {
  const left = parseStableVersion(leftVersion);
  const right = parseStableVersion(rightVersion);
  if (!left || !right) throw new Error("A plugin version is not strict stable SemVer.");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}
