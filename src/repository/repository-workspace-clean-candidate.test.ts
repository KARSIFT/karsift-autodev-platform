import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("ADP-013 merge candidate contains no temporary write-capable integration workflows", async () => {
  const workflowDirectory = path.resolve(process.cwd(), ".github/workflows");
  const entries = await readdir(workflowDirectory);
  const temporaryWorkflows = entries
    .filter((entry) => entry.startsWith("adp013-") && entry.endsWith(".yml"))
    .sort();

  assert.deepEqual(
    temporaryWorkflows,
    [],
    `Temporary ADP-013 workflows must be removed before merge: ${temporaryWorkflows.join(", ")}`,
  );
});
