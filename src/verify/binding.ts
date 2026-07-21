import type { ExternalBundle } from "./schema.js";

export const CANONICAL_JSON_ID = "promiseproof-canonical-json/v1" as const;
export const SHA256_ALGORITHM = "SHA-256" as const;

/** SHA-256 of src/shared/evaluator.ts after UTF-8 decoding and LF normalization. */
export const EVALUATOR_SOURCE_SHA256 =
  "fca20925861d1de2772ad0297a2465029678c4f34faa7a4755592f37aef9f87f" as const;

export interface InputBinding {
  readonly canonicalization: typeof CANONICAL_JSON_ID;
  readonly algorithm: typeof SHA256_ALGORITHM;
  readonly sha256: string;
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeCanonicalJson(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON accepts only finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeCanonicalJson);
  }
  if (typeof value === "object") {
    const normalized: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      normalized[key] = normalizeCanonicalJson(
        (value as Record<string, unknown>)[key],
      );
    }
    return normalized;
  }
  throw new TypeError(`Canonical JSON does not accept ${typeof value}.`);
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value));
}

function lowercaseHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return lowercaseHex(await globalThis.crypto.subtle.digest(SHA256_ALGORITHM, bytes));
}

export async function bindExternalBundle(
  bundle: ExternalBundle,
): Promise<InputBinding> {
  return bindCanonicalJson(canonicalizeJson(bundle));
}

export async function bindCanonicalJson(
  canonicalJson: string,
): Promise<InputBinding> {
  return {
    canonicalization: CANONICAL_JSON_ID,
    algorithm: SHA256_ALGORITHM,
    sha256: await sha256Utf8(canonicalJson),
  };
}

export function canonicalizeSourceLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export async function evaluatorSourceMatchesFingerprint(
  source: string,
  expected: string = EVALUATOR_SOURCE_SHA256,
): Promise<boolean> {
  return (
    (await sha256Utf8(canonicalizeSourceLineEndings(source))) === expected
  );
}
