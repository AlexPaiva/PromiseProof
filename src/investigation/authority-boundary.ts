const AUTHORITATIVE_OUTCOME_PATTERNS = [
  /\b(?:promise|contract|verification)\s+(?:passes|passed|is\s+verified|is\s+satisfied|was\s+kept|is\s+kept)\b/i,
  /\b(?:the\s+)?promise\s+holds\b/i,
  /\bverification\s+(?:succeeded|was\s+successful|is\s+successful)\b/i,
  /\brequirements?\s+(?:are|were)\s+met\b/i,
  /\b(?:the\s+)?product\s+(?:works|worked)\s+correctly\b/i,
  /\b(?:the\s+)?issue\s+(?:is|was)\s+fixed\b/i,
  /\bno\s+violation(?:s)?\b/i,
  /\b(?:compliant|non-compliant|noncompliant|compliance)\b/i,
  /\b(?:repair\s+succeeded|fixed|approved)\b/i,
] as const;

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

/**
 * Defense in depth for untrusted diagnostic prose. Structural schemas and the
 * deterministic evaluator remain the authority boundary; this phrase filter
 * is deliberately not treated as a semantic proof system.
 */
export function containsAuthoritativeOutcomeLanguage(value: unknown): boolean {
  return collectStrings(value).some((text) =>
    AUTHORITATIVE_OUTCOME_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
