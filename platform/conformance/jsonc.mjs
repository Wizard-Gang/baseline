// A small JSONC reader for wrangler configs: `//` and `/* */` comments and trailing commas, nothing else.
// Comment markers inside strings are kept, and the result is plain JSON.parse output.

/**
 * @param {string} source
 * @returns {unknown}
 */
export function parseJsonc(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== '"') index += source[index] === '\\' ? 2 : 1;
      if (index >= source.length) throw new SyntaxError('JSONC: unterminated string');
      index += 1;
      out += source.slice(start, index);
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('JSONC: unterminated block comment');
      out += ' ';
      index = end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return JSON.parse(withoutTrailingCommas(out));
}

// Drops a comma whose next significant character closes an object or array. Strings are skipped intact.
function withoutTrailingCommas(text) {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end;
    } else if (char === ',' && /^\s*[}\]]/.test(text.slice(index + 1))) {
      continue;
    } else {
      out += char;
    }
  }
  return out;
}
