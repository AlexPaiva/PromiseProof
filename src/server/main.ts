import { createApplication } from "./app.js";
import { readDemoMode } from "./domain.js";

function readPort(value = process.env.PORT): number {
  if (value === undefined) {
    return 4173;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid PORT "${value}".`);
  }

  return parsed;
}

readDemoMode();

const port = readPort();
const { application, dispose } = await createApplication();
const server = application.listen(port, "127.0.0.1", () => {
  console.log(`PromiseProof listening at http://127.0.0.1:${port}`);
});

let shuttingDown = false;

function shutDown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  server.close(async (error) => {
    try {
      await dispose();
    } catch (disposeError) {
      console.error(disposeError);
      process.exitCode = 1;
    }
    if (error !== undefined) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);
