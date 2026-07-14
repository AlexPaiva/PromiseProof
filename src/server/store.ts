import type {
  ActivityPayload,
  ActivityReceipt,
  PersonalizationPreference,
  PreferenceReceipt,
  RecommendationItem,
  RecommendationReceipt,
  RecommendationSource,
  RunEvidenceLedger,
} from "../shared/types.js";

interface StoredPreference {
  preference: PersonalizationPreference;
  updatedAt: string | null;
}

interface PreferenceUpdateResult extends StoredPreference {
  receipt: PreferenceReceipt;
}

const DEFAULT_PREFERENCE: StoredPreference = {
  preference: "on",
  updatedAt: null,
};

export class PromiseProofStore {
  readonly #preferences = new Map<string, StoredPreference>();
  readonly #evidence = new Map<string, RunEvidenceLedger>();

  getPreference(userId: string): StoredPreference {
    return this.#preferences.get(userId) ?? { ...DEFAULT_PREFERENCE };
  }

  updatePreference(
    userId: string,
    preference: PersonalizationPreference,
    runId: string,
  ): PreferenceUpdateResult {
    const receivedAt = new Date().toISOString();
    const stored = { preference, updatedAt: receivedAt };
    this.#preferences.set(userId, stored);

    const receipt = this.#append(runId, (sequence): PreferenceReceipt => ({
      sequence,
      kind: "preference",
      receiptId: `${runId}:${sequence}`,
      receivedAt,
      userId,
      preference,
    }));

    return { ...stored, receipt };
  }

  acknowledgePreferenceWithoutPersisting(
    userId: string,
    preference: PersonalizationPreference,
    runId: string,
  ): PreferenceUpdateResult {
    const receivedAt = new Date().toISOString();
    const receipt = this.#append(runId, (sequence): PreferenceReceipt => ({
      sequence,
      kind: "preference",
      receiptId: `${runId}:${sequence}`,
      receivedAt,
      userId,
      preference,
    }));

    return { preference, updatedAt: receivedAt, receipt };
  }

  recordActivity(payload: ActivityPayload): ActivityReceipt {
    const receivedAt = new Date().toISOString();

    return this.#append(
      payload.runId,
      (sequence): ActivityReceipt => ({
        kind: "activity",
        service: "recommendation",
        receiptId: `${payload.runId}:${sequence}`,
        sequence,
        receivedAt,
        payload: { ...payload },
      }),
    );
  }

  recordRecommendation(
    runId: string,
    source: RecommendationSource,
    items: RecommendationItem[],
    userId?: string,
  ): RecommendationReceipt {
    const receivedAt = new Date().toISOString();
    return this.#append(runId, (sequence): RecommendationReceipt => ({
      sequence,
      kind: "recommendation",
      receiptId: `${runId}:${sequence}`,
      receivedAt,
      source,
      items: items.map((item) => ({ ...item })),
      ...(userId === undefined ? {} : { userId }),
    }));
  }

  getEvidence(runId: string): RunEvidenceLedger {
    return structuredClone(this.#evidence.get(runId) ?? this.#emptyLedger(runId));
  }

  clearEvidence(runId: string): void {
    this.#evidence.delete(runId);
  }

  #append<T extends ActivityReceipt | PreferenceReceipt | RecommendationReceipt>(
    runId: string,
    createEvent: (sequence: number) => T,
  ): T {
    const ledger = this.#evidence.get(runId) ?? this.#emptyLedger(runId);
    const sequence =
      ledger.activityReceipts.length +
      ledger.preferenceReceipts.length +
      ledger.recommendationReceipts.length +
      1;
    const receipt = createEvent(sequence);

    if (receipt.kind === "activity") {
      ledger.activityReceipts.push(receipt);
    } else if (receipt.kind === "preference") {
      ledger.preferenceReceipts.push(receipt);
    } else {
      ledger.recommendationReceipts.push(receipt);
    }

    this.#evidence.set(runId, ledger);
    return receipt;
  }

  #emptyLedger(runId: string): RunEvidenceLedger {
    return {
      runId,
      activityReceipts: [],
      recommendationReceipts: [],
      preferenceReceipts: [],
    };
  }
}
