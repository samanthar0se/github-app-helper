import assert from "node:assert/strict";
import test from "node:test";

import { buildForkCommand, configureGitEnvironment, createOpenCodePlugin } from "../src/opencode-plugin-core.mjs";

test("configures fail-closed Git credentials for assigned repositories", async () => {
  const plugin = createOpenCodePlugin({
    repositoryProfileImpl: async (cwd) => ({ cwd, profile: { account: "owner" } }),
  });
  const hooks = await plugin();
  const output = { env: {} };

  await hooks["shell.env"]({ cwd: "C:/repo" }, output);

  assert.deepEqual(output.env, {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!github-app credential",
    GIT_CONFIG_KEY_2: "credential.useHttpPath",
    GIT_CONFIG_VALUE_2: "true",
    GIT_TERMINAL_PROMPT: "0",
  });
  assert.equal(output.env.GH_TOKEN, undefined);
  assert.equal(output.env.GITHUB_TOKEN, undefined);
});

test("leaves shell credentials unchanged for unassigned repositories", async () => {
  const plugin = createOpenCodePlugin({ repositoryProfileImpl: async () => ({ profile: undefined }) });
  const hooks = await plugin();
  const output = { env: { EXISTING: "value" } };

  await hooks["shell.env"]({ cwd: "C:/unassigned" }, output);

  assert.deepEqual(output.env, { EXISTING: "value" });
});

test("runs the github_app_gh tool in the session directory", async () => {
  let call;
  const plugin = createOpenCodePlugin({
    runGitHubCliImpl: async (arguments_, cwd) => {
      call = { arguments_, cwd };
      return { status: 0, stdout: "issue output\n", stderr: "" };
    },
  });
  const hooks = await plugin();

  const output = await hooks.tool.github_app_gh.execute(
    { arguments: ["issue", "list"] },
    { directory: "C:/repo" },
  );

  assert.deepEqual(call, { arguments_: ["issue", "list"], cwd: "C:/repo" });
  assert.equal(output, "issue output");
});

test("infers the configured repository from gh arguments", async () => {
  let call;
  const plugin = createOpenCodePlugin({
    runGitHubCliImpl: async (arguments_, cwd, options) => {
      call = { arguments_, cwd, options };
      return { status: 0, stdout: "repository output\n", stderr: "" };
    },
  });
  const hooks = await plugin();

  const output = await hooks.tool.github_app_gh.execute(
    { arguments: ["repo", "view", "samanthar0se/sandcastle"] },
    { directory: "C:/unassigned-workspace" },
  );

  assert.deepEqual(call, {
    arguments_: ["repo", "view", "samanthar0se/sandcastle"],
    cwd: "C:/unassigned-workspace",
    options: { repository: "samanthar0se/sandcastle" },
  });
  assert.equal(output, "repository output");
});

test("configureGitEnvironment does not add GitHub tokens", () => {
  const env = {};
  configureGitEnvironment(env);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("blocks direct gh commands through the shell", async () => {
  const hooks = await createOpenCodePlugin()();

  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: "git status; gh repo view" } },
    ),
    /Use github_app_gh.*do not retry through the shell/,
  );
});

test("allows non-gh shell commands", async () => {
  const hooks = await createOpenCodePlugin()();
  await hooks["tool.execute.before"](
    { tool: "bash" },
    { args: { command: "git status --short" } },
  );
});

test("builds a fork command without executing it", () => {
  assert.equal(
    buildForkCommand("openchamber/openchamber", "openchamber-agent"),
    'gh repo fork "openchamber/openchamber" --clone=false --fork-name "openchamber-agent"',
  );
});

test("rejects unsafe fork command inputs", () => {
  assert.throws(() => buildForkCommand("owner/repo; gh auth token"), /owner\/repository/);
  assert.throws(() => buildForkCommand("owner/repo", "name; whoami"), /fork name/);
});

test("github_fork_command returns a human-only handoff", async () => {
  const hooks = await createOpenCodePlugin({
    loadConfigImpl: async () => ({
      profiles: {
        "samantha-clanker": {
          account: "samanthar0se",
          principal: "samanthar0se",
        },
      },
    }),
  })();

  const output = await hooks.tool.github_fork_command.execute(
    { repository: "openchamber/openchamber" },
    {},
  );

  assert.match(output, /gh repo fork "openchamber\/openchamber" --clone=false/);
  assert.match(output, /Do not execute this command inside OpenCode/);
  assert.match(output, /wait for the user to confirm/);
  assert.match(output, /Expected fork: `samanthar0se\/openchamber`/);
  assert.match(output, /do not ask for the user's GitHub username/i);
  assert.match(output, /git remote rename origin upstream/);
  assert.match(output, /github-app use "samantha-clanker"/);
  assert.doesNotMatch(output, /github-app assign/);
});
