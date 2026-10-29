// Minimal readers for the repository's own block-style workflow YAML. They are not a general YAML parser.

/** The lines nested under `key:` at exactly `indent` spaces, or null when the key is absent. */
export function block(source, key, indent = 0) {
  const lines = source.split('\n');
  const marker = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line.trimEnd() === marker);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const spaces = line.match(/^ */)[0].length;
    if (spaces <= indent) { end = index; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

export function keys(source, indent) {
  if (source === null) return [];
  return [...source.matchAll(new RegExp(`^${' '.repeat(indent)}([A-Za-z0-9_-]+):(?:\\s|$)`, 'gm'))]
    .map((match) => match[1]);
}
