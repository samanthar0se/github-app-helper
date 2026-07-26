#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addProfile,
  credentialForRequest,
  loadConfig,
  parseCredentialInput,
  profileAccount,
  repositoryProfile,
  runGitHubCli,
  setAccount,
  setPrincipal,
  useProfile,
} from "./core.mjs";

function usage() {
  console.log("Usage:");
  console.log("  github-app add --name NAME --account OWNER --app-id ID --installation-id ID --slug SLUG --bot-user-id ID --principal GITHUB_LOGIN --key FILE");
  console.log("  github-app set-principal PROFILE GITHUB_LOGIN");
  console.log("  github-app set-account PROFILE OWNER");
  console.log("  github-app use PROFILE [REPOSITORY_PATH]");
  console.log("  github-app inspect [REPOSITORY_PATH]");
  console.log("  github-app gh [REPOSITORY_PATH] -- GH_ARGUMENTS");
  console.log("  github-app status");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function credentialHelper(arguments_) {
  if (arguments_[0] !== "get") return;
  let credential;
  try {
    credential = await credentialForRequest(parseCredentialInput(await readStdin()));
  } catch (error) {
    console.error(`github-app: ${error.message}`);
    credential = { quit: true };
  }
  if (!credential) return;
  if (credential.quit) console.log("quit=1");
  else {
    console.log(`username=${credential.username}`);
    console.log(`password=${credential.password}`);
  }
  console.log();
}

async function inspectRepository(repositoryPath) {
  const { cwd, repository, name, profile } = await repositoryProfile(repositoryPath);
  const gitConfig = (key) => {
    const result = spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const userName = gitConfig("user.name");
  const userEmail = gitConfig("user.email");
  console.log("Authentication: GitHub App installation token (ephemeral, not persisted)");
  console.log(`Repository: ${repository ?? "unknown"}`);
  console.log(`Profile: ${name ?? "unassigned"}`);
  console.log(`Human principal: ${profile?.principal ?? "unconfigured"}`);
  console.log(`Commit identity: ${userName && userEmail ? `${userName} <${userEmail}>` : "unconfigured (commits fail closed)"}`);
  console.log(`GitHub writes: ${profile ? "enabled through the App" : "blocked until the repository owner is configured"}`);
}

async function printStatus() {
  const entries = Object.entries((await loadConfig()).profiles);
  if (entries.length === 0) {
    console.log("No GitHub App profiles configured.");
    return;
  }
  for (const [name, profile] of entries) {
    console.log(`${name}: ${profile.slug}[bot] -> ${profileAccount(profile) ?? "unconfigured"}/* (@me -> ${profile.principal ?? "unconfigured"})`);
  }
}

export async function main(arguments_ = process.argv.slice(2)) {
  const [command, ...commandArguments] = arguments_;
  if (command === "add") {
    const { name, profile } = await addProfile(commandArguments);
    console.log(`Added ${name} for ${profile.account}/*`);
  } else if (command === "set-principal") {
    const [name, principal] = commandArguments;
    await setPrincipal(name, principal);
    console.log(`Configured ${name} to resolve @me as ${principal}`);
  } else if (command === "set-account") {
    const [name, account] = commandArguments;
    await setAccount(name, account);
    console.log(`Configured ${name} for ${account}/*`);
  } else if (command === "use") {
    const { repository, profile } = await useProfile(commandArguments[0], commandArguments[1]);
    console.log(`Configured ${repository} as ${profile.slug}[bot]`);
  } else if (command === "credential") {
    await credentialHelper(commandArguments);
  } else if (command === "gh") {
    const separator = commandArguments.indexOf("--");
    if (separator === -1) throw new Error("usage: github-app gh [REPOSITORY_PATH] -- GH_ARGUMENTS");
    const repositoryPath = separator === 0 ? "." : commandArguments[0];
    const result = await runGitHubCli(commandArguments.slice(separator + 1), repositoryPath, { stdio: "inherit" });
    return result.status ?? 1;
  } else if (command === "inspect") {
    await inspectRepository(commandArguments[0] ?? ".");
  } else if (command === "status") {
    await printStatus();
  } else {
    usage();
  }
  return 0;
}

const entryPath = process.argv[1] && resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`github-app: ${error.message}`);
    process.exitCode = 1;
  }
}
