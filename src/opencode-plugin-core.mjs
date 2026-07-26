import { tool } from "@opencode-ai/plugin";

import { GitHubAppError, loadConfig, repositoryProfile, runGitHubCli } from "./core.mjs";
import {
  buildForkCommand,
  configureGitEnvironment,
  directGitHubCliMessage,
  forkHandoffMessage,
  forkProfile,
  githubAppToolDescriptions,
  invokesGitHubCli,
  repositoryFromGitHubArguments,
} from "./plugin-shared.mjs";

export { buildForkCommand, configureGitEnvironment, repositoryFromGitHubArguments };

const HOST = "OpenCode";

export function createOpenCodePlugin(dependencies = {}) {
  const loadConfigImpl = dependencies.loadConfigImpl ?? loadConfig;
  const repositoryProfileImpl = dependencies.repositoryProfileImpl ?? repositoryProfile;
  const runGitHubCliImpl = dependencies.runGitHubCliImpl ?? runGitHubCli;

  return async () => ({
    tool: {
      github_app_gh: tool({
        description: githubAppToolDescriptions.github_app_gh,
        args: {
          arguments: tool.schema.array(tool.schema.string()).min(1).describe("Arguments passed directly to gh, for example ['issue', 'list']"),
          repository: tool.schema.string().optional().describe("Configured owner/name repository to use when the session directory is not that repository"),
        },
        async execute(args, context) {
          const repository = args.repository ?? repositoryFromGitHubArguments(args.arguments);
          const result = repository
            ? await runGitHubCliImpl(args.arguments, context.directory, { repository })
            : await runGitHubCliImpl(args.arguments, context.directory);
          if (result.status !== 0) {
            throw new GitHubAppError(result.stderr?.trim() || `gh exited with status ${result.status}`);
          }
          return result.stdout?.trim() || result.stderr?.trim() || "gh completed successfully";
        },
      }),
      github_fork_command: tool({
        description: githubAppToolDescriptions.github_fork_command(HOST),
        args: {
          repository: tool.schema.string().describe("Public source repository in owner/repository format"),
          name: tool.schema.string().optional().describe("Optional name for the new fork"),
          account: tool.schema.string().optional().describe("Destination account when more than one GitHub App account is configured"),
        },
        async execute(args) {
          const [profileName, profile] = forkProfile(await loadConfigImpl(), args.account);
          return forkHandoffMessage({ host: HOST, profileName, profile, repository: args.repository, name: args.name });
        },
      }),
    },
    "shell.env": async (input, output) => {
      const { profile } = await repositoryProfileImpl(input.cwd);
      if (profile) configureGitEnvironment(output.env);
    },
    "tool.execute.before": async (input, output) => {
      if (!["bash", "shell"].includes(input.tool) || typeof output.args?.command !== "string") return;
      if (invokesGitHubCli(output.args.command)) {
        throw new GitHubAppError(directGitHubCliMessage(HOST));
      }
    },
  });
}
