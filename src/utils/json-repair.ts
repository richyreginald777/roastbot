// Gemini (observed on gemini-3.5-flash under load) sometimes returns JSON
// truncated right before the closing brace(s), even with
// responseMimeType: application/json. Strict JSON.parse throws away an
// otherwise-complete response. This helper repairs the common truncations:
// an unclosed string, then missing closing braces.

export function parseModelJson<T>(raw: string): T | null {
  const s = (raw || '').trim();
  if (!s) return null;

  try {
    return JSON.parse(s) as T;
  } catch {
    // fall through to repair
  }

  let repaired = s;

  // Close a dangling string (odd number of unescaped quotes)
  const quotes = repaired.match(/(?<!\\)"/g)?.length ?? 0;
  if (quotes % 2 === 1) repaired += '"';

  // Balance braces/brackets
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
