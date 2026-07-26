#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { directGitHubCliMessage, invokesGitHubCli } from "../plugin-shared.mjs";

const HOST = "Claude Code";

export function evaluateHookInput(input) {
  if (input?.tool_name !== "Bash") return undefined;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !invokesGitHubCli(command)) return undefined;
  return directGitHubCliMessage(HOST);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

const entryPath = process.argv[1] && resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const refusal = evaluateHookInput(input);
  if (refusal) {
    // Exit code 2 blocks the tool call and returns stderr to the model.
    console.error(refusal);
    process.exit(2);
  }
  process.exit(0);
}
