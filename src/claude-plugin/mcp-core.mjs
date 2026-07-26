import { GitHubAppError, loadConfig, runGitHubCli } from "../core.mjs";
import {
  forkHandoffMessage,
  forkProfile,
  githubAppToolDescriptions,
  repositoryFromGitHubArguments,
} from "../plugin-shared.mjs";

export const HOST = "Claude Code";
export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "github-app", version: "1.0.0" };

export const tools = [
  {
    name: "github_app_gh",
    description: githubAppToolDescriptions.github_app_gh,
    inputSchema: {
      type: "object",
      properties: {
        arguments: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Arguments passed directly to gh, for example ['issue', 'list']",
        },
        repository: {
          type: "string",
          description: "Configured owner/name repository to use when the session directory is not that repository",
        },
      },
      required: ["arguments"],
      additionalProperties: false,
    },
  },
  {
    name: "github_fork_command",
    description: githubAppToolDescriptions.github_fork_command(HOST),
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Public source repository in owner/repository format" },
        name: { type: "string", description: "Optional name for the new fork" },
        account: { type: "string", description: "Destination account when more than one GitHub App account is configured" },
      },
      required: ["repository"],
      additionalProperties: false,
    },
  },
];

/**
 * MCP servers have no per-call session directory, so the repository comes from the
 * process working directory that Claude Code spawned the server in, from gh
 * arguments, or from an explicit override.
 */
export function createToolHandlers(dependencies = {}) {
  const loadConfigImpl = dependencies.loadConfigImpl ?? loadConfig;
  const runGitHubCliImpl = dependencies.runGitHubCliImpl ?? runGitHubCli;
  const cwdImpl = dependencies.cwdImpl ?? (() => process.cwd());

  return {
    async github_app_gh(args) {
      if (!Array.isArray(args?.arguments) || args.arguments.length === 0) {
        throw new GitHubAppError("arguments must be a non-empty array of gh arguments");
      }
      const directory = args.directory ?? cwdImpl();
      const repository = args.repository ?? repositoryFromGitHubArguments(args.arguments);
      const result = repository
        ? await runGitHubCliImpl(args.arguments, directory, { repository })
        : await runGitHubCliImpl(args.arguments, directory);
      if (result.status !== 0) {
        throw new GitHubAppError(result.stderr?.trim() || `gh exited with status ${result.status}`);
      }
      return result.stdout?.trim() || result.stderr?.trim() || "gh completed successfully";
    },
    async github_fork_command(args) {
      if (typeof args?.repository !== "string") {
        throw new GitHubAppError("repository is required in owner/repository format");
      }
      const [profileName, profile] = forkProfile(await loadConfigImpl(), args.account);
      return forkHandoffMessage({ host: HOST, profileName, profile, repository: args.repository, name: args.name });
    },
  };
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handles one JSON-RPC message. Returns undefined for notifications, which carry no
 * id and must not be answered.
 */
export async function handleMessage(message, handlers) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return undefined;

  if (method === "initialize") {
    return result(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools });
  if (method === "tools/call") {
    const handler = handlers[params?.name];
    if (!handler) {
      return result(id, { content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true });
    }
    try {
      return result(id, { content: [{ type: "text", text: await handler(params.arguments ?? {}) }] });
    } catch (error) {
      return result(id, { content: [{ type: "text", text: `github-app: ${error.message}` }], isError: true });
    }
  }
  return failure(id, -32601, `unknown method ${method}`);
}

/**
 * Splits a growing stdin buffer into complete newline-delimited JSON messages,
 * returning the messages and the unterminated remainder.
 */
export function drainMessages(buffer) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // A malformed line cannot be attributed to a request id, so it is dropped.
    }
  }
  return { messages, remainder };
}
