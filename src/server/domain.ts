export const DEMO_MODE = "initialization-race" as const;

export type DemoMode = typeof DEMO_MODE;

export function readDemoMode(value = process.env.DEMO_MODE): DemoMode {
  const configuredMode = value ?? DEMO_MODE;

  if (configuredMode !== DEMO_MODE) {
    throw new Error(
      `Unsupported DEMO_MODE "${configuredMode}". Expected "${DEMO_MODE}".`,
    );
  }

  return configuredMode;
}
