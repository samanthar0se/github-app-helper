import assert from "node:assert/strict";
import test from "node:test";

import { rewriteGitHubArguments } from "../src/core.mjs";

test("resolves @me for issue claims", () => {
  assert.deepEqual(
    rewriteGitHubArguments(["issue", "edit", "42", "--add-assignee", "@me"], "samanthar0se"),
    ["issue", "edit", "42", "--add-assignee", "samanthar0se"],
  );
});

test("resolves @me in equals and comma-separated forms", () => {
  assert.deepEqual(
    rewriteGitHubArguments(["issue", "edit", "42", "--add-assignee=@me,octocat"], "samanthar0se"),
    ["issue", "edit", "42", "--add-assignee=samanthar0se,octocat"],
  );
});

test("resolves @me when creating an issue", () => {
  assert.deepEqual(
    rewriteGitHubArguments(["issue", "create", "--title", "Test", "-a", "@me"], "samanthar0se"),
    ["issue", "create", "--title", "Test", "-a", "samanthar0se"],
  );
});

test("does not rewrite @me in bodies or unrelated commands", () => {
  assert.deepEqual(
    rewriteGitHubArguments(["issue", "comment", "42", "--body", "ping @me"], "samanthar0se"),
    ["issue", "comment", "42", "--body", "ping @me"],
  );
});

test("fails closed when an assignment has no principal", () => {
  assert.throws(
    () => rewriteGitHubArguments(["issue", "edit", "42", "--add-assignee", "@me"], undefined),
    /set-principal/,
  );
});
