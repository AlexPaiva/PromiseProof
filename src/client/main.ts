import "./styles.css";

import type {
  ActivityPayload,
  ActivityReceipt,
  ClientTimelineEntry,
  DemoMode,
  PersonalizationPreference,
  RecommendationItem,
  RecommendationReceipt,
  RecommendationSource,
  RunEvidenceLedger,
} from "../shared/types";

declare global {
  interface Window {
    __PP_TIMELINE__: ClientTimelineEntry[];
    __PP_APP_READY__: boolean;
  }
}

interface PreferenceResponse {
  userId: string;
  preference: PersonalizationPreference;
  updatedAt?: string;
}

interface ConfigurationResponse {
  demoMode: DemoMode;
}

interface ActivityResponse {
  accepted: true;
  receipt: ActivityReceipt;
}

interface RecommendationResponse {
  source: RecommendationSource;
  items: RecommendationItem[];
  receipt: RecommendationReceipt;
}

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DEFAULT_RUN_ID = "demo-run";
const DEFAULT_USER_ID = "synthetic-user-001";
const STARTUP_ITEM_ID = "signal-shelf-home";

const query = new URLSearchParams(window.location.search);
const runId = safeIdentifier(query.get("runId"), DEFAULT_RUN_ID);
const userId = safeIdentifier(query.get("userId"), DEFAULT_USER_ID);
const storageKey = `promiseproof:personalization:${userId}`;

// The race fixture deliberately uses this unsafe default before hydration. The
// propagation fixture hydrates first, isolating its separate write-boundary fault.
let inMemoryPreference: PersonalizationPreference = "on";
let backendPreference: PersonalizationPreference | null = null;
let recommendationSource: RecommendationSource | null = null;

window.__PP_TIMELINE__ = [];
window.__PP_APP_READY__ = false;

const appRoot = required<HTMLElement>("#app-root");
const toggle = required<HTMLInputElement>("#personalization-toggle");
const preferenceState = required<HTMLElement>("#preference-state");
const browserPreference = required<HTMLElement>("#browser-preference");
const storedPreferenceElement = required<HTMLElement>("#stored-preference");
const backendPreferenceElement = required<HTMLElement>("#backend-preference");
const preferenceAgreement = required<HTMLElement>("#preference-agreement");
const sourceBadge = required<HTMLElement>("#recommendation-source");
const evidenceSource = required<HTMLElement>("#evidence-recommendation-source");
const itemsContainer = required<HTMLElement>("#recommendation-items");
const receiptLabel = required<HTMLElement>("#activity-receipt-label");
const receiptCount = required<HTMLElement>("#activity-receipt-count");
const timeline = required<HTMLOListElement>("#startup-timeline");
const syncStatus = required<HTMLElement>("#sync-status");
const runIdElement = required<HTMLElement>("#run-id");

runIdElement.textContent = runId;
renderPreference();

toggle.addEventListener("change", () => {
  void updatePreference(toggle.checked ? "on" : "off");
});

void startApplication();

async function startApplication(): Promise<void> {
  try {
    const { demoMode } = await fetchJson<ConfigurationResponse>(
      "/api/configuration",
      { referrerPolicy: "no-referrer" },
    );

    if (demoMode === "initialization-race") {
      setStatus("Collector starting with the in-memory default…", "working");

      // The await is the seeded race: hydration cannot begin until a real
      // recommendation-service activity receipt has already returned.
      await runStartupCollector();
      await hydratePreference();
    } else {
      setStatus("Restoring the saved preference before collection…", "working");
      await hydratePreference();
      await runStartupCollector();
    }

    await loadRecommendations();
    await refreshEvidence();

    appRoot.dataset.ready = "true";
    window.__PP_APP_READY__ = true;
    toggle.disabled = false;
    renderPreferenceStatus();
  } catch (error) {
    appRoot.dataset.ready = "error";
    window.__PP_APP_READY__ = false;
    setStatus(readableError(error), "error");
    itemsContainer.setAttribute("aria-busy", "false");
  }
}

async function runStartupCollector(): Promise<void> {
  recordTimeline("collector_started", {
    inMemoryPreference,
  });

  if (inMemoryPreference !== "on") {
    recordTimeline("collector_suppressed", { inMemoryPreference });
    return;
  }

  const dispatched = recordTimeline("activity_dispatched", {
    eventType: "page_view",
    userId,
  });
  const payload: ActivityPayload = {
    runId,
    userId,
    eventType: "page_view",
    itemId: STARTUP_ITEM_ID,
    clientSequence: dispatched.sequence,
    occurredAt: dispatched.timestamp,
  };

  const response = await fetchJson<ActivityResponse>(
    "/api/recommendations/activity",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      referrerPolicy: "no-referrer",
    },
  );

  recordTimeline("activity_received", {
    receiptId: response.receipt.receiptId,
    service: response.receipt.service,
  });
}

async function hydratePreference(): Promise<void> {
  recordTimeline("preference_hydration_started");

  const response = await fetchJson<PreferenceResponse>(
    `/api/preferences/${encodeURIComponent(userId)}`,
    { referrerPolicy: "no-referrer" },
  );
  let hydratedPreference = response.preference;
  let authoritativePreference = response.preference;
  const storedPreference = readStoredPreference();

  // The browser value represents the user's last explicit choice. If a fresh
  // backend has no matching state, restore that choice before rendering a feed.
  if (storedPreference !== null && storedPreference !== response.preference) {
    recordTimeline("preference_sync_dispatched", {
      preference: storedPreference,
    });
    const restored = await persistBackendPreference(storedPreference);
    hydratedPreference = restored.preference;
    recordTimeline("preference_sync_acknowledged", {
      preference: restored.preference,
    });

    const readback = await fetchBackendPreference();
    authoritativePreference = readback.preference;
    recordTimeline("backend_preference_observed", {
      preference: readback.preference,
    });
  } else {
    writeStoredPreference(hydratedPreference);
  }

  inMemoryPreference = hydratedPreference;
  backendPreference = authoritativePreference;
  renderPreference();
  renderBackendPreference();

  recordTimeline("preference_hydration_completed", {
    preference: hydratedPreference,
    backendPreference: authoritativePreference,
    restoredFromBrowser:
      storedPreference !== null && storedPreference !== response.preference,
  });
}

async function updatePreference(
  requestedPreference: PersonalizationPreference,
): Promise<void> {
  const previousPreference = inMemoryPreference;
  toggle.disabled = true;
  toggle.checked = requestedPreference === "on";
  setStatus(
    `Saving personalization ${requestedPreference.toUpperCase()}…`,
    "working",
  );

  try {
    const response = await persistBackendPreference(requestedPreference);
    inMemoryPreference = response.preference;
    backendPreference = response.preference;
    writeStoredPreference(response.preference);
    renderPreference();
    renderBackendPreference();
    await loadRecommendations();
    await refreshEvidence();
    renderPreferenceStatus();
  } catch (error) {
    inMemoryPreference = previousPreference;
    renderPreference();
    setStatus(`Preference was not changed. ${readableError(error)}`, "error");
  } finally {
    toggle.disabled = false;
  }
}

async function persistBackendPreference(
  preference: PersonalizationPreference,
): Promise<PreferenceResponse> {
  return fetchJson<PreferenceResponse>(
    `/api/preferences/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preference, runId }),
      referrerPolicy: "no-referrer",
    },
  );
}

async function fetchBackendPreference(): Promise<PreferenceResponse> {
  return fetchJson<PreferenceResponse>(
    `/api/preferences/${encodeURIComponent(userId)}`,
    { referrerPolicy: "no-referrer" },
  );
}

async function loadRecommendations(): Promise<void> {
  itemsContainer.setAttribute("aria-busy", "true");
  setSourceBadge(null);

  const headers = { "x-promiseproof-run-id": runId };
  const endpoint =
    inMemoryPreference === "off"
      ? "/api/recommendations/contextual"
      : `/api/recommendations/behavioral?userId=${encodeURIComponent(userId)}`;

  // The contextual request intentionally contains no user identifier. Explicitly
  // suppressing its referrer also prevents the page query string from leaking one.
  const response = await fetchJson<RecommendationResponse>(endpoint, {
    headers,
    referrerPolicy: "no-referrer",
  });

  recommendationSource = response.source;
  renderRecommendations(response.items);
  setSourceBadge(response.source);
  recordTimeline("recommendation_rendered", {
    source: response.source,
    itemCount: response.items.length,
  });
}

async function refreshEvidence(): Promise<void> {
  const [ledger, authoritativePreference] = await Promise.all([
    fetchJson<RunEvidenceLedger>(`/api/evidence/${encodeURIComponent(runId)}`, {
      referrerPolicy: "no-referrer",
    }),
    fetchBackendPreference(),
  ]);
  const offBoundary =
    inMemoryPreference === "off" && readStoredPreference() === "off"
      ? [...ledger.preferenceReceipts]
          .reverse()
          .find((receipt) => receipt.preference === "off")?.sequence
      : undefined;
  const activityTotal =
    offBoundary === undefined
      ? ledger.activityReceipts.length
      : ledger.activityReceipts.filter(
          (receipt) => receipt.sequence > offBoundary,
        ).length;

  receiptLabel.textContent =
    offBoundary === undefined ? "Activity receipts" : "Activity after OFF";
  receiptCount.textContent = String(activityTotal);
  receiptCount.dataset.count = String(activityTotal);

  backendPreference = authoritativePreference.preference;
  renderBackendPreference();
}

function renderPreference(): void {
  const isOn = inMemoryPreference === "on";
  const state = isOn ? "on" : "off";

  toggle.checked = isOn;
  preferenceState.textContent = state.toUpperCase();
  preferenceState.dataset.state = state;
  browserPreference.textContent = state.toUpperCase();
  browserPreference.dataset.state = state;
  appRoot.dataset.preference = state;
  renderStoredPreference();
  renderPreferenceAgreement();
}

function renderStoredPreference(): void {
  const storedPreference = readStoredPreference();
  if (storedPreference === null) {
    storedPreferenceElement.textContent = "—";
    storedPreferenceElement.dataset.state = "missing";
    return;
  }

  storedPreferenceElement.textContent = storedPreference.toUpperCase();
  storedPreferenceElement.dataset.state = storedPreference;
}

function renderBackendPreference(): void {
  if (backendPreference === null) {
    backendPreferenceElement.textContent = "—";
    backendPreferenceElement.dataset.state = "loading";
    appRoot.dataset.backendPreference = "unknown";
    renderPreferenceAgreement();
    return;
  }

  backendPreferenceElement.textContent = backendPreference.toUpperCase();
  backendPreferenceElement.dataset.state = backendPreference;
  appRoot.dataset.backendPreference = backendPreference;
  renderPreferenceAgreement();
}

function renderPreferenceAgreement(): void {
  const storedPreference = readStoredPreference();
  if (storedPreference === null || backendPreference === null) {
    preferenceAgreement.textContent = "CHECKING";
    preferenceAgreement.dataset.state = "loading";
    return;
  }

  const matches =
    storedPreference === inMemoryPreference &&
    backendPreference === inMemoryPreference;
  preferenceAgreement.textContent = matches ? "MATCH" : "MISMATCH";
  preferenceAgreement.dataset.state = matches ? "match" : "mismatch";
}

function renderPreferenceStatus(): void {
  const storedPreference = readStoredPreference();
  if (
    storedPreference !== null &&
    backendPreference !== null &&
    storedPreference === inMemoryPreference &&
    backendPreference === inMemoryPreference
  ) {
    setStatus("Preference synced. Evidence is current.", "synced");
    return;
  }

  setStatus(
    `State mismatch: UI ${inMemoryPreference.toUpperCase()}, stored ${String(storedPreference).toUpperCase()}, backend ${String(backendPreference).toUpperCase()}.`,
    "error",
  );
}

function renderRecommendations(items: RecommendationItem[]): void {
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const article = document.createElement("article");
    article.className = "recommendation-card";
    article.dataset.testid = "recommendation-item";
    article.dataset.itemId = item.id;

    const marker = document.createElement("div");
    marker.className = "card-marker";
    marker.setAttribute("aria-hidden", "true");

    const eyebrow = document.createElement("p");
    eyebrow.className = "card-eyebrow";
    eyebrow.dataset.testid = "recommendation-item-eyebrow";
    eyebrow.textContent = item.eyebrow;

    const title = document.createElement("h2");
    title.dataset.testid = "recommendation-item-title";
    title.textContent = item.title;

    const description = document.createElement("p");
    description.className = "card-description";
    description.dataset.testid = "recommendation-item-description";
    description.textContent = item.description;

    const action = document.createElement("span");
    action.className = "card-action";
    action.textContent = "Open note";
    action.setAttribute("aria-hidden", "true");

    article.append(marker, eyebrow, title, description, action);
    fragment.append(article);
  }

  itemsContainer.replaceChildren(fragment);
  itemsContainer.setAttribute("aria-busy", "false");
}

function setSourceBadge(source: RecommendationSource | null): void {
  sourceBadge.classList.remove(
    "source-loading",
    "source-contextual",
    "source-behavioral",
  );

  if (source === null) {
    sourceBadge.classList.add("source-loading");
    sourceBadge.dataset.source = "loading";
    sourceBadge.lastChild?.remove();
    sourceBadge.append("Loading feed");
    evidenceSource.textContent = "—";
    evidenceSource.dataset.source = "loading";
    return;
  }

  const label = source === "contextual" ? "Context-only feed" : "Activity-shaped feed";
  sourceBadge.classList.add(`source-${source}`);
  sourceBadge.dataset.source = source;
  sourceBadge.lastChild?.remove();
  sourceBadge.append(label);
  evidenceSource.textContent = source === "contextual" ? "CONTEXTUAL" : "BEHAVIORAL";
  evidenceSource.dataset.source = source;
}

function recordTimeline(
  event: string,
  detail?: ClientTimelineEntry["detail"],
): ClientTimelineEntry {
  const entry: ClientTimelineEntry = {
    sequence: window.__PP_TIMELINE__.length + 1,
    event,
    timestamp: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
  };
  window.__PP_TIMELINE__.push(entry);
  renderTimeline();
  return entry;
}

function renderTimeline(): void {
  const fragment = document.createDocumentFragment();

  for (const entry of window.__PP_TIMELINE__) {
    const item = document.createElement("li");
    item.dataset.event = entry.event;
    item.dataset.sequence = String(entry.sequence);

    const sequence = document.createElement("span");
    sequence.className = "timeline-sequence";
    sequence.textContent = String(entry.sequence).padStart(2, "0");

    const content = document.createElement("span");
    content.className = "timeline-content";

    const name = document.createElement("strong");
    name.textContent = humanizeEvent(entry.event);

    const time = document.createElement("time");
    time.dateTime = entry.timestamp;
    time.textContent = formatTime(entry.timestamp);

    content.append(name, time);
    item.append(sequence, content);
    fragment.append(item);
  }

  timeline.replaceChildren(fragment);
}

function readStoredPreference(): PersonalizationPreference | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === "on" || stored === "off" ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredPreference(preference: PersonalizationPreference): void {
  try {
    window.localStorage.setItem(storageKey, preference);
  } catch {
    // The backend remains the durable source if browser storage is unavailable.
  }
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function setStatus(
  message: string,
  state: "working" | "synced" | "error",
): void {
  syncStatus.textContent = message;
  syncStatus.dataset.state = state;
}

function safeIdentifier(value: string | null, fallback: string): string {
  return value !== null && SAFE_IDENTIFIER.test(value) ? value : fallback;
}

function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Required interface element is missing: ${selector}`);
  }
  return element;
}

function humanizeEvent(event: string): string {
  return event
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date(timestamp));
}

function readableError(error: unknown): string {
  return error instanceof Error
    ? `Demo could not finish: ${error.message}.`
    : "Demo could not finish the request.";
}

export {};
