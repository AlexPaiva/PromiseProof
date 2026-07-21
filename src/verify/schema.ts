import { z } from "zod";

import {
  SUPPORTED_CONTRACT_FAMILY,
  SUPPORTED_SCHEMA_VERSION,
} from "./outcome.js";

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_COLLECTION_ITEMS = 100;

const SAFE_VISIBLE_CHARACTERS =
  /^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]*$/u;

const visibleIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/\S/, "Identifier must contain a non-whitespace character")
  .regex(
    SAFE_VISIBLE_CHARACTERS,
    "Developer-visible text contains a forbidden control or bidi character",
  );
const isoTimestamp = z.iso.datetime({ offset: true });
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const preference = z.enum(["on", "off"]);
const recommendationSource = z.enum(["contextual", "behavioral"]);

function boundedArray<T extends z.ZodType>(schema: T) {
  return z.array(schema).max(MAX_COLLECTION_ITEMS);
}

export const externalActivitySchema = z
  .object({
    runId: visibleIdentifier,
    subjectId: visibleIdentifier,
    eventType: z.literal("page_view"),
    itemId: visibleIdentifier,
    clientSequence: sequence,
    occurredAt: isoTimestamp,
  })
  .strict();

export const externalRecommendationReceiptSchema = z
  .object({
    source: recommendationSource,
    subjectId: visibleIdentifier.optional(),
    itemIds: boundedArray(visibleIdentifier),
  })
  .strict();

export const externalEvidenceV1Schema = z
  .object({
    scenario: preference,
    subjectId: visibleIdentifier,
    control: z
      .object({
        uiPreference: preference,
        toggleChecked: z.boolean(),
        storedPreference: preference.nullable(),
        backendPreference: preference,
        reloadObserved: z.boolean(),
      })
      .strict(),
    activity: z
      .object({
        capturedActivities: boundedArray(externalActivitySchema),
        recommendationServiceReceipts: boundedArray(externalActivitySchema),
      })
      .strict(),
    recommendations: z
      .object({
        feedFunctional: z.boolean(),
        renderedSource: recommendationSource,
        renderedItemIds: boundedArray(visibleIdentifier),
        recommendationServiceReceipts: boundedArray(
          externalRecommendationReceiptSchema,
        ),
      })
      .strict(),
  })
  .strict();

export const externalBundleSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
    contractFamily: z.literal(SUPPORTED_CONTRACT_FAMILY),
    evidence: externalEvidenceV1Schema,
  })
  .strict()
  .meta({
    id: "https://promiseproof.local/schemas/activity-personalization.v1.schema.json",
    title: "PromiseProof activity-personalization/v1 evidence bundle",
    description:
      "Externally supplied evaluator-relevant facts for the single activity-personalization/v1 contract family.",
  });

export type ExternalActivity = z.infer<typeof externalActivitySchema>;
export type ExternalRecommendationReceipt = z.infer<
  typeof externalRecommendationReceiptSchema
>;
export type ExternalEvidenceV1 = z.infer<typeof externalEvidenceV1Schema>;
export type ExternalBundle = z.infer<typeof externalBundleSchema>;

export function externalBundleJsonSchema(): z.core.JSONSchema.JSONSchema {
  return z.toJSONSchema(externalBundleSchema, {
    target: "draft-2020-12",
  });
}
