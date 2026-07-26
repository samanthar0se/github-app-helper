import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createToken, credentialForRequest, findProfileForRepository, runGitHubCli, setAccount } from "../src/core.mjs";

const profile = {
  appId: "123",
  account: "owner",
  installationId: "456",
  privateKey: "unused.pem",
  principal: "octocat",
  repositories: ["owner/allowed"],
};

test("requests a token scoped to the matched repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let request;
  const token = await createToken(profile, "owner/allowed", {
    now: () => 1_700_000_000_000,
    readFileImpl: async () => privateKey.export({ type: "pkcs8", format: "pem" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ token: "scoped-token" }) };
    },
  });

  assert.equal(token, "scoped-token");
  assert.equal(request.url, "https://api.github.com/app/installations/456/access_tokens");
  assert.deepEqual(JSON.parse(request.options.body), { repositories: ["allowed"] });
});

test("returns quit for an unassigned GitHub credential", async () => {
  const credential = await credentialForRequest(
    { host: "github.com", path: "other/unassigned.git" },
    { config: { profiles: { app: profile } } },
  );
  assert.deepEqual(credential, { quit: true });
});

test("passes a token only to the gh child process", async () => {
  const inheritedToken = process.env.GH_TOKEN;
  let invocation;
  const result = await runGitHubCli(["issue", "list"], "C:/repo", {
    env: { SAFE: "value" },
    repositoryProfileImpl: async () => ({ cwd: "C:/repo", repository: "owner/allowed", profile }),
    createTokenImpl: async () => "child-token",
    spawnSyncImpl: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return { status: 0, stdout: "ok\n", stderr: "" };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(invocation.command, "gh");
  assert.deepEqual(invocation.arguments_, ["issue", "list"]);
  assert.equal(invocation.options.env.GH_TOKEN, "child-token");
  assert.equal(invocation.options.env.GITHUB_TOKEN, "child-token");
  assert.equal(invocation.options.env.SAFE, "value");
  assert.equal(process.env.GH_TOKEN, inheritedToken);
});

test("blocks gh commands that can expose the child token", async () => {
  let resolvedRepository = false;
  await assert.rejects(
    runGitHubCli(["auth", "token"], "C:/repo", {
      repositoryProfileImpl: async () => {
        resolvedRepository = true;
      },
    }),
    /gh auth is unavailable/,
  );
  assert.equal(resolvedRepository, false);
});

test("uses an explicit configured repository outside its worktree", async () => {
  let selection;
  let invocation;
  await runGitHubCli(["repo", "view"], "C:/unassigned-workspace", {
    repository: "owner/allowed",
    repositoryProfileImpl: async () => {
      throw new Error("cwd lookup should not run");
    },
    configuredRepositoryProfileImpl: async (repository, cwd) => {
      selection = { repository, cwd };
      return { cwd, repository, profile };
    },
    createTokenImpl: async () => "child-token",
    spawnSyncImpl: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return { status: 0, stdout: "ok\n", stderr: "" };
    },
  });

  assert.deepEqual(selection, { repository: "owner/allowed", cwd: "C:/unassigned-workspace" });
  assert.equal(invocation.options.env.GH_REPO, "owner/allowed");
});

test("routes every repository owned by the configured account", () => {
  const config = { profiles: { app: profile } };
  assert.equal(findProfileForRepository(config, "owner/new-repository")?.[0], "app");
  assert.equal(findProfileForRepository(config, "other/allowed"), undefined);
});

test("migrates a legacy repository list to an account", async () => {
  const config = {
    profiles: {
      app: { ...profile, account: undefined, repositories: ["owner/one", "owner/two"] },
    },
  };
  let savedConfig;

  await setAccount("app", "owner", {
    config,
    saveConfigImpl: async (value) => {
      savedConfig = value;
    },
  });

  assert.equal(savedConfig.profiles.app.account, "owner");
  assert.equal("repositories" in savedConfig.profiles.app, false);
});
