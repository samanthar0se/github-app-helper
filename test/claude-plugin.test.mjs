import assert from "node:assert/strict";
import test from "node:test";

import { createToolHandlers, drainMessages, handleMessage, tools } from "../src/claude-plugin/mcp-core.mjs";
import { evaluateHookInput } from "../src/claude-plugin/pre-tool-use.mjs";
import { configureRepository, gitConfigCommands } from "../src/claude-plugin/session-start.mjs";

test("advertises both GitHub App tools with object schemas", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});

  assert.deepEqual(response.result.tools.map((entry) => entry.name), ["github_app_gh", "github_fork_command"]);
  for (const entry of tools) {
    assert.equal(entry.inputSchema.type, "object");
    assert.ok(entry.description.length > 0);
  }
});

test("echoes the client protocol version on initialize", async () => {
  const response = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    {},
  );

  assert.equal(response.result.protocolVersion, "2025-03-26");
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, "github-app");
});

test("does not answer notifications", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, {}), undefined);
});

test("runs the github_app_gh tool in the server working directory", async () => {
  let call;
  const handlers = createToolHandlers({
    cwdImpl: () => "C:/repo",
    runGitHubCliImpl: async (arguments_, cwd, options) => {
      call = { arguments_, cwd, options };
      return { status: 0, stdout: "issue output\n", stderr: "" };
    },
  });

  const response = await handleMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "github_app_gh", arguments: { arguments: ["issue", "list"] } } },
    handlers,
  );

  assert.deepEqual(call, { arguments_: ["issue", "list"], cwd: "C:/repo", options: undefined });
  assert.equal(response.result.content[0].text, "issue output");
  assert.equal(response.result.isError, undefined);
});

test("infers the configured repository from gh arguments", async () => {
  let call;
  const handlers = createToolHandlers({
    cwdImpl: () => "C:/unassigned-workspace",
    runGitHubCliImpl: async (arguments_, cwd, options) => {
      call = { arguments_, cwd, options };
      return { status: 0, stdout: "repository output", stderr: "" };
    },
  });

  await handlers.github_app_gh({ arguments: ["repo", "view", "samanthar0se/sandcastle"] });

  assert.deepEqual(call.options, { repository: "samanthar0se/sandcastle" });
});

test("reports gh failures as tool errors rather than transport errors", async () => {
  const handlers = createToolHandlers({
    runGitHubCliImpl: async () => ({ status: 1, stdout: "", stderr: "GraphQL: Resource not accessible\n" }),
  });

  const response = await handleMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "github_app_gh", arguments: { arguments: ["issue", "list"] } } },
    handlers,
  );

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Resource not accessible/);
  assert.equal(response.error, undefined);
});

test("github_fork_command returns a Claude Code human-only handoff", async () => {
  const handlers = createToolHandlers({
    loadConfigImpl: async () => ({
      profiles: { "samantha-clanker": { account: "samanthar0se", principal: "samanthar0se" } },
    }),
  });

  const output = await handlers.github_fork_command({ repository: "openchamber/openchamber" });

  assert.match(output, /gh repo fork "openchamber\/openchamber" --clone=false/);
  assert.match(output, /Do not execute this command inside Claude Code/);
  assert.match(output, /Expected fork: `samanthar0se\/openchamber`/);
  assert.match(output, /github-app use "samantha-clanker"/);
});

test("rejects empty gh argument lists", async () => {
  const handlers = createToolHandlers({ runGitHubCliImpl: async () => assert.fail("gh must not run") });
  await assert.rejects(handlers.github_app_gh({ arguments: [] }), /non-empty array/);
});

test("splits newline-delimited messages and keeps the remainder", () => {
  const { messages, remainder } = drainMessages('{"id":1}\n{"id":2}\n{"id":3');

  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
  assert.equal(remainder, '{"id":3');
});

test("blocks direct gh commands in the Bash tool", () => {
  assert.match(
    evaluateHookInput({ tool_name: "Bash", tool_input: { command: "git status; gh repo view" } }),
    /Use github_app_gh.*do not retry through the shell/,
  );
});

test("allows non-gh Bash commands and other tools", () => {
  assert.equal(evaluateHookInput({ tool_name: "Bash", tool_input: { command: "git status --short" } }), undefined);
  assert.equal(evaluateHookInput({ tool_name: "Read", tool_input: { file_path: "gh" } }), undefined);
});

test("installs a fail-closed credential helper only for assigned repositories", async () => {
  const calls = [];
  const context = await configureRepository("C:/repo", {
    repositoryProfileImpl: async () => ({ repository: "samanthar0se/sandcastle", name: "samantha-clanker", profile: {} }),
    spawnSyncImpl: (command, arguments_) => calls.push([command, ...arguments_]),
  });

  assert.deepEqual(calls, gitConfigCommands().map((arguments_) => ["git", ...arguments_]));
  assert.match(context, /github_app_gh/);
  assert.match(context, /samantha-clanker/);
});

test("leaves unassigned repositories untouched", async () => {
  const context = await configureRepository("C:/unassigned", {
    repositoryProfileImpl: async () => ({ profile: undefined }),
    spawnSyncImpl: () => assert.fail("git must not run"),
  });

  assert.equal(context, undefined);
});

test("clears inherited credential helpers before adding the App helper", () => {
  const commands = gitConfigCommands();

  assert.deepEqual(commands[0], ["config", "--local", "--unset-all", "credential.helper"]);
  assert.deepEqual(commands[1], ["config", "--local", "--add", "credential.helper", ""]);
  assert.equal(commands.some((entry) => entry.includes("!github-app credential")), true);
});
