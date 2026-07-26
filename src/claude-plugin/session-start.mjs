#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryProfile } from "../core.mjs";

/**
 * Claude Code has no per-command shell environment hook, so the credential helper is
 * written to the repository's local Git config instead of the OpenCode plugin's
 * ephemeral GIT_CONFIG_* variables. The writes are idempotent and scoped to
 * repositories whose owner matches a configured App installation account.
 */
export function gitConfigCommands() {
  return [
    ["config", "--local", "--unset-all", "credential.helper"],
    ["config", "--local", "--add", "credential.helper", ""],
    ["config", "--local", "--add", "credential.helper", "!github-app credential"],
    ["config", "--local", "credential.useHttpPath", "true"],
  ];
}

export async function configureRepository(cwd, dependencies = {}) {
  const repositoryProfileImpl = dependencies.repositoryProfileImpl ?? repositoryProfile;
  const spawnSyncImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const { repository, name, profile } = await repositoryProfileImpl(cwd);
  if (!profile) return undefined;
  for (const arguments_ of gitConfigCommands()) {
    // --unset-all exits 5 when the key is absent, which is the normal first run.
    spawnSyncImpl("git", arguments_, { cwd, encoding: "utf8" });
  }
  return [
    `GitHub App profile \`${name}\` routes \`${repository}\`. Git pushes and fetches use short-lived installation tokens through the \`github-app credential\` helper.`,
    "Use the `github_app_gh` MCP tool for all GitHub CLI work. Direct `gh` commands in Bash are blocked.",
    "Use `github_fork_command` when a fork requires human GitHub authentication.",
  ].join(" ");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

const entryPath = process.argv[1] && resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    input = {};
  }
  try {
    const context = await configureRepository(input.cwd ?? process.cwd());
    if (context) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      })}\n`);
    }
  } catch (error) {
    console.error(`github-app: ${error.message}`);
  }
  process.exit(0);
}
