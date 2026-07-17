// Gemini has been observed (on gemini-3.5-flash under load) returning JSON
// that is malformed in BOTH directions, even with responseMimeType json:
//   - truncated before the closing brace(s)          → pad missing closers
//   - complete object followed by trailing garbage    → balanced-prefix extract
// With responseJsonSchema (structured outputs) this should no longer happen —
// this helper remains as the final safety net.

/** Extract the first balanced top-level JSON object/array from a string. */
function extractBalancedPrefix(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // never balanced — likely truncated
}

export function parseModelJson<T>(raw: string): T | null {
  const s = (raw || '').trim();
  if (!s) return null;

  // 1. Happy path
  try {
    return JSON.parse(s) as T;
  } catch {
    // fall through
  }

  // 2. Over-terminated / trailing garbage: parse the first balanced object
  const prefix = extractBalancedPrefix(s);
  if (prefix) {
    try {
      return JSON.parse(prefix) as T;
    } catch {
      // fall through
    }
  }

  // 3. Truncated: close a dangling string, then balance braces/brackets
  let repaired = s;
  const quotes = repaired.match(/(?<!\\)"/g)?.length ?? 0;
  if (quotes % 2 === 1) repaired += '"';

  const opensCurly = (repaired.match(/{/g) || []).length;
  const closesCurly = (repaired.match(/}/g) || []).length;
  const opensSquare = (repaired.match(/\[/g) || []).length;
  const closesSquare = (repaired.match(/]/g) || []).length;
  if (opensSquare > closesSquare) repaired += ']'.repeat(opensSquare - closesSquare);
  if (opensCurly > closesCurly) repaired += '}'.repeat(opensCurly - closesCurly);

  try {
    return JSON.parse(repaired) as T;
  } catch {
    return null;
  }
}
