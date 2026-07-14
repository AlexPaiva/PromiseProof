import type { Request } from "express";

import type {
  ActivityPayload,
  PersonalizationPreference,
} from "../shared/types.js";

export class RequestValidationError extends Error {
  readonly code = "PP_INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RequestValidationError(`${label} must be a JSON object.`);
  }

  return value;
}

function requirePattern(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RequestValidationError(`${label} has an invalid format.`);
  }

  return value;
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));

  if (unexpected.length > 0) {
    throw new RequestValidationError(
      `Unexpected field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`,
    );
  }
}

export function parseRunId(value: unknown, label = "runId"): string {
  return requirePattern(value, label, RUN_ID_PATTERN);
}

export function parseUserId(value: unknown, label = "userId"): string {
  return requirePattern(value, label, USER_ID_PATTERN);
}

export function parsePreferenceUpdate(value: unknown): {
  preference: PersonalizationPreference;
  runId: string;
} {
  const body = requireRecord(value, "Request body");
  rejectUnexpectedKeys(body, ["preference", "runId"]);

  if (body.preference !== "on" && body.preference !== "off") {
    throw new RequestValidationError(
      'preference must be either "on" or "off".',
    );
  }

  return {
    preference: body.preference,
    runId: parseRunId(body.runId),
  };
}

export function parseActivityPayload(value: unknown): ActivityPayload {
  const body = requireRecord(value, "Request body");
  rejectUnexpectedKeys(body, [
    "runId",
    "userId",
    "eventType",
    "itemId",
    "clientSequence",
    "occurredAt",
  ]);

  if (body.eventType !== "page_view") {
    throw new RequestValidationError('eventType must be "page_view".');
  }

  if (!Number.isSafeInteger(body.clientSequence) || Number(body.clientSequence) < 1) {
    throw new RequestValidationError(
      "clientSequence must be a positive integer.",
    );
  }

  if (
    typeof body.occurredAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(body.occurredAt) ||
    !Number.isFinite(Date.parse(body.occurredAt)) ||
    new Date(body.occurredAt).toISOString() !== body.occurredAt
  ) {
    throw new RequestValidationError(
      "occurredAt must be a valid ISO-8601 timestamp.",
    );
  }

  return {
    runId: parseRunId(body.runId),
    userId: parseUserId(body.userId),
    eventType: body.eventType,
    itemId: requirePattern(body.itemId, "itemId", ITEM_ID_PATTERN),
    clientSequence: Number(body.clientSequence),
    occurredAt: body.occurredAt,
  };
}

export function parseRunIdHeader(request: Request): string {
  const value = request.header("x-promiseproof-run-id");
  return parseRunId(value, "x-promiseproof-run-id header");
}

export function rejectQueryParameters(request: Request): void {
  const keys = Object.keys(request.query);
  if (keys.length > 0) {
    throw new RequestValidationError(
      `Contextual recommendations do not accept query parameters (${keys.join(", ")}).`,
    );
  }
}
