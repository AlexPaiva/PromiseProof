import {
  formatJudgeOutput,
  runJudgeRehearsal,
} from '../src/judge/rehearsal.js';

try {
  await runJudgeRehearsal();
  process.stdout.write(formatJudgeOutput());
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
