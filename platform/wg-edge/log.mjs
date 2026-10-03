// Structured logs: one JSON object per line, so Workers Logs can filter by field.
// Request logs carry the path but never the query string, headers, cookies or bodies.

/** @typedef {'info' | 'warn' | 'error'} LogLevel */
/** @typedef {(level: LogLevel, event: string, fields?: Record<string, unknown>) => void} Logger */

/** @param {string} line */
function consoleSink(line) {
  console.log(line);
}

/**
 * Errors are reduced to name and message. Stack traces stay out of logs as well as responses.
 * @param {unknown} value
 */
function plain(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/**
 * @param {string} app
 * @param {(line: string) => void} [sink]
 * @returns {Logger}
 */
export function createLogger(app, sink = consoleSink) {
  return (level, event, fields = {}) => {
    const entry = { ts: new Date().toISOString(), level, app, event };
    for (const [key, value] of Object.entries(fields)) {
      if (!(key in entry)) entry[key] = plain(value);
    }
    try {
      sink(JSON.stringify(entry));
    } catch {
      sink(JSON.stringify({ ts: entry.ts, level, app, event, unserializable: true }));
    }
  };
}
