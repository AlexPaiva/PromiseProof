import type {
  DemoMode,
  PersonalizationPreference,
} from "../shared/types.js";
import { PromiseProofStore } from "./store.js";

export class PreferenceService {
  constructor(
    private readonly store: PromiseProofStore,
    private readonly demoMode: DemoMode,
  ) {}

  update(
    userId: string,
    preference: PersonalizationPreference,
    runId: string,
  ): ReturnType<PromiseProofStore["updatePreference"]> {
    // Seeded defect: the boundary acknowledges OFF and records the attempt, but
    // omits the authoritative store mutation. A write-only test therefore passes;
    // a deterministic write/read replay exposes the contradiction.
    if (this.demoMode === "propagation-failure" && preference === "off") {
      return this.store.acknowledgePreferenceWithoutPersisting(
        userId,
        preference,
        runId,
      );
    }

    return this.store.updatePreference(userId, preference, runId);
  }
}
