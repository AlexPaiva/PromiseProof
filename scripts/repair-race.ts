import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateRepairLifecycle } from '../src/repair/artifact.js';
import { OpenAICodexRepairProvider } from '../src/repair/codex-provider.js';
import {
  readBoundRepairState,
  retryRepairCleanup,
  reviewRaceRepairInteractively,
  verifyHumanApprovedRaceRepair,
} from '../src/repair/repair-flow.js';
import {
  prepareRaceRepair,
  recoverStaleRepairLock,
} from '../src/repair/runner.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function usage(): never {
  throw new Error(
    [
      'Usage:',
      '  repair-race.ts prepare',
      '  repair-race.ts status <repair-id>',
      '  repair-race.ts review <repair-id>',
      '  repair-race.ts verify <repair-id>',
      '  repair-race.ts cleanup <repair-id>',
      '  repair-race.ts recover-lock',
      '',
      'There is intentionally no --yes, automatic approval, or piped-review mode.',
    ].join('\n'),
  );
}

function requireRepairId(value: string | undefined): string {
  if (value === undefined || process.argv.length !== 4) {
    return usage();
  }
  return value;
}

async function status(repairId: string): Promise<void> {
  const { state } = await readBoundRepairState(projectRoot, repairId);
  const lifecycle = validateRepairLifecycle(
    JSON.parse(await readFile(state.lifecyclePath, 'utf8')) as unknown,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        repairId: state.repairId,
        state: state.state,
        baseCommit: state.baseCommit,
        candidateWorktreePath: state.candidateWorktreePath,
        verificationWorktreePath: state.verificationWorktreePath,
        patch: state.patch,
        provider:
          state.provider === null
            ? null
            : {
                kind: state.provider.kind,
                requestedModel: state.provider.requestedModel,
                sdkVersion: state.provider.sdkVersion,
                cliVersion: state.provider.cliVersion,
                threadId: state.provider.threadId,
                usage: state.provider.usage,
                events: state.provider.events,
                validationCodes: state.provider.validationCodes,
              },
        providerFailure: state.providerFailure,
        failure: state.failure,
        approvalSha256: state.approvalSha256,
        verificationReceiptPath: state.verificationReceiptPath,
        verificationReceiptSha256: state.verificationReceiptSha256,
        lifecycle: lifecycle.events.map((event) => ({
          sequence: event.sequence,
          state: event.state,
          recordedAt: event.recordedAt,
          eventSha256: event.eventSha256,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || command === undefined) {
    return usage();
  }

  if (command === 'prepare') {
    if (argument !== undefined) {
      return usage();
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length < 20) {
      throw new Error(
        'PP_REPAIR_CODEX_KEY_MISSING: set OPENAI_API_KEY only in ignored .env.local before live preparation.',
      );
    }
    const result = await prepareRaceRepair({
      projectRoot,
      provider: new OpenAICodexRepairProvider(),
      apiKey,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          nextCommand: `npm run repair:race:review -- ${result.repairId}`,
          automaticApproval: false,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'recover-lock') {
    if (argument !== undefined) {
      return usage();
    }
    const result = await recoverStaleRepairLock(projectRoot);
    process.stdout.write(
      `${JSON.stringify({ recovered: true, deadPid: result.deadPid }, null, 2)}\n`,
    );
    return;
  }

  const repairId = requireRepairId(argument);
  if (command === 'status') {
    await status(repairId);
    return;
  }
  if (command === 'review') {
    const result = await reviewRaceRepairInteractively(projectRoot, repairId);
    process.stdout.write(
      `${JSON.stringify(
        {
          repairId,
          decision: result.decision.decision,
          patchSha256: result.decision.patchSha256,
          state: result.state,
          nextCommand:
            result.decision.decision === 'approved'
              ? `npm run repair:race:verify -- ${repairId}`
              : null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const result = await verifyHumanApprovedRaceRepair({
      projectRoot,
      repairId,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          repairId,
          verdict: result.receipt.verdict,
          authority: 'unchanged_playwright_and_deterministic_evaluator',
          receiptPath: result.receiptPath,
          cleanupState: result.cleanupState,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'cleanup') {
    const state = await retryRepairCleanup(projectRoot, repairId);
    process.stdout.write(
      `${JSON.stringify({ repairId, state: state.state }, null, 2)}\n`,
    );
    return;
  }
  return usage();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
