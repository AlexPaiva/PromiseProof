import { z } from "zod";

import {
  SUPPORTED_CONTRACT_FAMILY,
  SUPPORTED_SCHEMA_VERSION,
} from "./outcome.js";

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_COLLECTION_ITEMS = 100;

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/\S/, "Identifier must contain a non-whitespace character");
const shortText = z.string().max(512);
const longText = z.string().max(2_048);
const isoTimestamp = z.iso.datetime({ offset: true });
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const preference = z.enum(["on", "off"]);
const recommendationSource = z.enum(["contextual", "behavioral"]);

function boundedArray<T extends z.ZodType>(schema: T) {
  return z.array(schema).max(MAX_COLLECTION_ITEMS);
}

const activityPayloadSchema = z
  .object({
    runId: identifier,
    userId: identifier,
    eventType: z.literal("page_view"),
    itemId: identifier,
    clientSequence: sequence,
    occurredAt: isoTimestamp,
  })
  .strict();

const activityReceiptSchema = z
  .object({
    kind: z.literal("activity"),
    service: z.literal("recommendation"),
    receiptId: identifier,
    sequence,
    receivedAt: isoTimestamp,
    payload: activityPayloadSchema,
  })
  .strict();

const recommendationItemSchema = z
  .object({
    id: identifier,
    title: shortText,
    description: longText,
    eyebrow: shortText,
  })
  .strict();

const recommendationReceiptSchema = z
  .object({
    kind: z.literal("recommendation"),
    receiptId: identifier,
    sequence,
    receivedAt: isoTimestamp,
    source: recommendationSource,
    userId: identifier.optional(),
    items: boundedArray(recommendationItemSchema),
  })
  .strict();

const preferenceReceiptSchema = z
  .object({
    kind: z.literal("preference"),
    receiptId: identifier,
    sequence,
    receivedAt: isoTimestamp,
    userId: identifier,
    preference,
  })
  .strict();

const preferenceUpdatePayloadSchema = z
  .object({
    runId: identifier,
    preference,
  })
  .strict();

const preferenceUpdateRequestSchema = z
  .object({
    targetUserId: identifier,
    payload: preferenceUpdatePayloadSchema,
  })
  .strict();

const preferenceUpdateResponseSchema = z
  .object({
    userId: identifier,
    preference,
    updatedAt: isoTimestamp,
    receipt: preferenceReceiptSchema,
  })
  .strict();

const timelineDetailValueSchema = z.union([
  z.string().max(2_048),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const clientTimelineEntrySchema = z
  .object({
    sequence,
    event: identifier,
    timestamp: isoTimestamp,
    detail: z.record(z.string().max(256), timelineDetailValueSchema).optional(),
  })
  .strict();

export const promiseEvidenceSchema = z
  .object({
    scenario: preference,
    runId: identifier,
    userId: identifier,
    ui: z
      .object({
        preference,
        toggleChecked: z.boolean(),
        feedFunctional: z.boolean(),
      })
      .strict(),
    storage: z
      .object({
        preference: preference.nullable(),
      })
      .strict(),
    request: z
      .object({
        activityPayloads: boundedArray(activityPayloadSchema),
        preferenceUpdates: boundedArray(preferenceUpdateRequestSchema),
      })
      .strict(),
    response: z
      .object({
        preferenceUpdates: boundedArray(preferenceUpdateResponseSchema),
      })
      .strict(),
    backend: z
      .object({
        preference,
        activityReceipts: boundedArray(activityReceiptSchema),
        recommendationReceipts: boundedArray(recommendationReceiptSchema),
        preferenceReceipts: boundedArray(preferenceReceiptSchema),
      })
      .strict(),
    recommendation: z
      .object({
        source: recommendationSource,
        itemIds: boundedArray(identifier),
      })
      .strict(),
    timestamps: z
      .object({
        clientTimeline: boundedArray(clientTimelineEntrySchema),
        activityReceivedAt: boundedArray(isoTimestamp),
        preferenceReceivedAt: boundedArray(isoTimestamp),
        recommendationReceivedAt: boundedArray(isoTimestamp),
      })
      .strict(),
    journey: z
      .object({
        reloadObserved: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const externalBundleSchema = z
  .object({
    schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
    contractFamily: z.literal(SUPPORTED_CONTRACT_FAMILY),
    evidence: promiseEvidenceSchema,
  })
  .strict()
  .meta({
    id: "https://promiseproof.local/schemas/activity-personalization.v1.schema.json",
    title: "PromiseProof activity-personalization/v1 evidence bundle",
    description:
      "Externally supplied evidence for the single activity-personalization/v1 contract family.",
  });

export type ExternalBundle = z.infer<typeof externalBundleSchema>;

export function externalBundleJsonSchema(): z.core.JSONSchema.JSONSchema {
  return z.toJSONSchema(externalBundleSchema, {
    target: "draft-2020-12",
  });
}
