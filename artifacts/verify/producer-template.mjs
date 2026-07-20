import { readFile, writeFile } from "node:fs/promises";

const [evidenceFile = "promise-evidence.json", outputFile = "bundle.json"] =
  process.argv.slice(2);
const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
const bundle = {
  schemaVersion: "1",
  contractFamily: "activity-personalization/v1",
  evidence,
};

await writeFile(
  outputFile,
  `${JSON.stringify(bundle, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);
