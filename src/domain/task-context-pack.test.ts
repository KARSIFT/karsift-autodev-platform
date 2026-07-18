import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRepositorySnapshot,
  contractSection,
  normalizeRelevantPaths,
} from "./task-context-pack.js";

test("relevant paths are normalized, deduplicated, and sorted", () => {
  assert.deepEqual(
    normalizeRelevantPaths([
      "src/b.ts",
      " src/a.ts ",
      "src/b.ts",
      "docs\\guide.md",
      "",
    ]),
    ["docs/guide.md", "src/a.ts", "src/b.ts"],
  );
});

test("unsafe or non-normalized repository paths are rejected", () => {
  assert.throws(() => normalizeRelevantPaths(["../secret"]), /traversal/);
  assert.throws(() => normalizeRelevantPaths(["/absolute"]), /repository-relative/);
  assert.throws(() => normalizeRelevantPaths(["src//file.ts"]), /normalized/);
  assert.throws(() => normalizeRelevantPaths(["./src/file.ts"]), /normalized/);
});

test("repository snapshot requires a stable branch and lowercase commit SHA", () => {
  assert.doesNotThrow(() =>
    assertRepositorySnapshot("develop", "a".repeat(40)),
  );
  assert.throws(() => assertRepositorySnapshot(" ", "a".repeat(40)), /baseBranch/);
  assert.throws(() => assertRepositorySnapshot(" develop ", "a".repeat(40)), /baseBranch/);
  assert.throws(() => assertRepositorySnapshot("develop", "A".repeat(40)), /baseCommitSha/);
});

test("contract sections use explicit deterministic fallbacks", () => {
  const content = {
    objective: "Ship the change",
    acceptanceCriteria: ["Passes"],
  };

  assert.equal(contractSection(content, "objective", null), "Ship the change");
  assert.deepEqual(
    contractSection(content, "acceptanceCriteria", []),
    ["Passes"],
  );
  assert.deepEqual(contractSection(content, "tests", []), []);
  assert.equal(contractSection("not-an-object", "objective", null), null);
});
