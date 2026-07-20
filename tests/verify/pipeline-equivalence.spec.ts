import { expect, test } from "@playwright/test";

import { evaluatePromise } from "../../src/shared/evaluator.js";
import { adaptExternalEvidence } from "../../src/verify/adapter.js";
import { runPromiseScenario } from "../support/scenario.js";
import { projectCanonicalEvidence } from "./canonical-projection.js";

function stable(value: unknown): string {
  return JSON.stringify(value);
}

for (const scenario of ["off", "on"] as const) {
  test(`real ${scenario.toUpperCase()} evidence survives projection and adaptation exactly`, async ({
    page,
    request,
  }, testInfo) => {
    const result = await runPromiseScenario(page, request, testInfo, scenario, {
      runId: `external-equivalence-${scenario}`,
      userId: `external-equivalence-subject-${scenario}`,
    });
    const roundTripped = evaluatePromise(
      adaptExternalEvidence(projectCanonicalEvidence(result.evidence)),
    );

    expect(result.browserErrors).toEqual([]);
    expect(
      result.evaluation.violations.map((violation) => violation.code),
    ).toEqual(
      scenario === "on"
        ? []
        : testInfo.project.name === "initialization-race"
          ? ["PP_IDENTIFIABLE_EVENT_LEAK"]
          : ["PP_PREFERENCE_NOT_PERSISTED"],
    );
    expect(stable(roundTripped)).toBe(stable(result.evaluation));
  });
}
