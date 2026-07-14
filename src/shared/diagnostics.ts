import type {
  PromiseClauseId,
  PromiseEvaluation,
} from "./types.js";

export const DIAGNOSTIC_REPLAYS = {
  inspectStartupOrder: {
    id: "inspect_startup_order",
    description:
      "Reload with an existing OFF choice and report collector and hydration order.",
  },
  inspectPreferenceRoundtrip: {
    id: "inspect_preference_roundtrip",
    description:
      "Write OFF, then read the authoritative preference and report both observations.",
  },
} as const;

export type DiagnosticReplayId =
  (typeof DIAGNOSTIC_REPLAYS)[keyof typeof DIAGNOSTIC_REPLAYS]["id"];

function clausePassed(
  evaluation: PromiseEvaluation,
  id: PromiseClauseId,
): boolean | undefined {
  return evaluation.clauses.find((item) => item.id === id)?.passed;
}

// This chooser is intentionally evidence-only. Seed configuration is not part of
// its input, so a future model can replace the chooser without changing replay
// implementations or the deterministic verification boundary.
export function selectDiagnosticReplay(
  evaluation: PromiseEvaluation,
): DiagnosticReplayId | null {
  const noActivity = clausePassed(evaluation, "no_identifiable_activity");
  const contextualFeed = clausePassed(
    evaluation,
    "contextual_feed_functional",
  );
  const preferencePersisted = clausePassed(
    evaluation,
    "preference_survives_reload",
  );

  if (noActivity === false && contextualFeed === true && preferencePersisted === true) {
    return DIAGNOSTIC_REPLAYS.inspectStartupOrder.id;
  }

  if (noActivity === true && contextualFeed === true && preferencePersisted === false) {
    return DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.id;
  }

  return null;
}
