import type { DemoMode } from "../shared/types.js";

export const DEFAULT_DEMO_MODE: DemoMode = "initialization-race";

export const DEMO_MODES: readonly DemoMode[] = [
  "initialization-race",
  "propagation-failure",
];

export function readDemoMode(value = process.env.DEMO_MODE): DemoMode {
  const configuredMode = value ?? DEFAULT_DEMO_MODE;

  if (!DEMO_MODES.includes(configuredMode as DemoMode)) {
    throw new Error(
      `Unsupported DEMO_MODE "${configuredMode}". Expected one of: ${DEMO_MODES.join(", ")}.`,
    );
  }

  return configuredMode as DemoMode;
}
