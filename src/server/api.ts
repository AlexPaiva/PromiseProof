import { Router, type RequestHandler } from "express";

import type {
  DemoMode,
  RecommendationItem,
  RecommendationSource,
} from "../shared/types.js";
import { PreferenceService } from "./preference-service.js";
import { PromiseProofStore } from "./store.js";
import {
  parseActivityPayload,
  parsePreferenceUpdate,
  parseRunId,
  parseRunIdHeader,
  parseUserId,
  rejectQueryParameters,
  RequestValidationError,
} from "./validation.js";

const CONTEXTUAL_ITEMS: readonly RecommendationItem[] = [
  {
    id: "context-typescript",
    title: "Reliable TypeScript services",
    description: "A practical guide to predictable service boundaries.",
    eyebrow: "Popular in Developer Tools",
  },
  {
    id: "context-testing",
    title: "Testing real HTTP boundaries",
    description: "See how end-to-end tests preserve trustworthy evidence.",
    eyebrow: "Trending in software quality",
  },
  {
    id: "context-observability",
    title: "Evidence-driven observability",
    description: "Turn runtime receipts into understandable product signals.",
    eyebrow: "Featured engineering topic",
  },
];

const BEHAVIORAL_ITEMS: readonly RecommendationItem[] = [
  {
    id: "behavior-playwright",
    title: "Advanced Playwright journeys",
    description: "Build deterministic journeys through real browser behavior.",
    eyebrow: "Based on this synthetic profile's activity",
  },
  {
    id: "behavior-contracts",
    title: "Personalization contract tests",
    description: "Express user-facing choices as executable guarantees.",
    eyebrow: "Related to previously viewed testing tools",
  },
  {
    id: "behavior-recommendations",
    title: "Recommendation system diagnostics",
    description: "Trace recommendation inputs without losing causal context.",
    eyebrow: "Matched to this synthetic profile's interests",
  },
];

function cloneItems(items: readonly RecommendationItem[]): RecommendationItem[] {
  return items.map((item) => ({ ...item }));
}

function recommendationResponse(
  source: RecommendationSource,
  items: readonly RecommendationItem[],
): { source: RecommendationSource; items: RecommendationItem[] } {
  return { source, items: cloneItems(items) };
}

function route(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function createApiRouter(
  store: PromiseProofStore,
  demoMode: DemoMode,
): Router {
  const router = Router();
  const preferences = new PreferenceService(store, demoMode);

  router.get("/health", (_request, response) => {
    response.json({ ok: true, demoMode });
  });

  router.get("/configuration", (_request, response) => {
    response.json({ demoMode });
  });

  router.get(
    "/preferences/:userId",
    route((request, response) => {
      const userId = parseUserId(request.params.userId);
      const stored = store.getPreference(userId);
      response.json({ userId, ...stored });
    }),
  );

  router.put(
    "/preferences/:userId",
    route((request, response) => {
      const userId = parseUserId(request.params.userId);
      const { preference, runId } = parsePreferenceUpdate(request.body);
      const stored = preferences.update(userId, preference, runId);
      response.json({ userId, ...stored });
    }),
  );

  router.post(
    "/recommendations/activity",
    route((request, response) => {
      const payload = parseActivityPayload(request.body);
      const receipt = store.recordActivity(payload);
      response.status(202).json({ accepted: true, receipt });
    }),
  );

  router.get(
    "/recommendations/contextual",
    route((request, response) => {
      rejectQueryParameters(request);
      const runId = parseRunIdHeader(request);
      const result = recommendationResponse("contextual", CONTEXTUAL_ITEMS);
      const receipt = store.recordRecommendation(runId, result.source, result.items);
      response.json({ ...result, receipt });
    }),
  );

  router.get(
    "/recommendations/behavioral",
    route((request, response) => {
      const queryKeys = Object.keys(request.query);
      if (queryKeys.length !== 1 || queryKeys[0] !== "userId") {
        throw new RequestValidationError(
          'Behavioral recommendations require only the "userId" query parameter.',
        );
      }

      const runId = parseRunIdHeader(request);
      const userId = parseUserId(request.query.userId);
      const result = recommendationResponse("behavioral", BEHAVIORAL_ITEMS);
      const receipt = store.recordRecommendation(
        runId,
        result.source,
        result.items,
        userId,
      );
      response.json({ ...result, receipt });
    }),
  );

  router.get(
    "/evidence/:runId",
    route((request, response) => {
      const runId = parseRunId(request.params.runId);
      response.json(store.getEvidence(runId));
    }),
  );

  router.delete(
    "/evidence/:runId",
    route((request, response) => {
      const runId = parseRunId(request.params.runId);
      store.clearEvidence(runId);
      response.json({ runId, cleared: true });
    }),
  );

  return router;
}
