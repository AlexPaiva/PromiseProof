import type { DiagnosticReplayId } from '../shared/diagnostics.js';
import type { NormalizedReplayOutputV1 } from './contracts.js';
import { normalizeReplayOutputV1 } from './dossier.js';
import { diagnosticReplayIdSchema } from './schemas.js';

export type ReplayExecutor = () => Promise<unknown>;

export interface ReplayExecutors {
  inspect_startup_order: ReplayExecutor;
  inspect_preference_roundtrip: ReplayExecutor;
}

export class ReplayDispatchError extends Error {
  constructor(
    readonly code:
      | 'PP_INV_UNKNOWN_REPLAY'
      | 'PP_INV_REPLAY_LIMIT'
      | 'PP_INV_REPLAY_REPORT_INVALID',
  ) {
    super(code);
    this.name = 'ReplayDispatchError';
  }
}

export class ReplayDispatcher {
  private executionCount = 0;

  constructor(private readonly executors: ReplayExecutors) {}

  get executions(): number {
    return this.executionCount;
  }

  async execute(replayId: unknown): Promise<NormalizedReplayOutputV1> {
    if (this.executionCount >= 1) {
      throw new ReplayDispatchError('PP_INV_REPLAY_LIMIT');
    }

    const parsedReplayId = diagnosticReplayIdSchema.safeParse(replayId);
    if (!parsedReplayId.success) {
      throw new ReplayDispatchError('PP_INV_UNKNOWN_REPLAY');
    }

    this.executionCount += 1;
    let rawReport: unknown;

    if (parsedReplayId.data === 'inspect_startup_order') {
      rawReport = await this.executors.inspect_startup_order();
    } else {
      rawReport = await this.executors.inspect_preference_roundtrip();
    }

    try {
      return normalizeReplayOutputV1(parsedReplayId.data, rawReport);
    } catch {
      throw new ReplayDispatchError('PP_INV_REPLAY_REPORT_INVALID');
    }
  }
}

export function isDiagnosticReplayId(value: unknown): value is DiagnosticReplayId {
  return diagnosticReplayIdSchema.safeParse(value).success;
}
