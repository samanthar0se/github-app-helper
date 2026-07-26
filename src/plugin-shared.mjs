import { GitHubAppError, profileAccount } from "./core.mjs";

export function configureGitEnvironment(env) {
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = "credential.helper";
  env.GIT_CONFIG_VALUE_1 = "!github-app credential";
  env.GIT_CONFIG_KEY_2 = "credential.useHttpPath";
  env.GIT_CONFIG_VALUE_2 = "true";
  env.GIT_TERMINAL_PROMPT = "0";
}

function normalizeRepository(value) {
  const match = value?.match(/(?:^|github\.com[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.[1];
}

export function repositoryFromGitHubArguments(arguments_) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--repo" || argument === "-R") return normalizeRepository(arguments_[index + 1]);
    if (argument.startsWith("--repo=") || argument.startsWith("-R=")) {
      return normalizeRepository(argument.slice(argument.indexOf("=") + 1));
    }
  }
  if (arguments_[0] === "repo") return normalizeRepository(arguments_[2]);
  return undefined;
}

export function buildForkCommand(repository, forkName, organization) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new GitHubAppError("repository must use the owner/repository format");
  }
  if (forkName && !/^[A-Za-z0-9._-]+$/.test(forkName)) {
    throw new GitHubAppError("fork name may contain only letters, numbers, periods, underscores, and hyphens");
  }
  if (organization && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) {
    throw new GitHubAppError("organization must be a GitHub organization login");
  }
  const nameOption = forkName ? ` --fork-name "${forkName}"` : "";
  const organizationOption = organization ? ` --org "${organization}"` : "";
  return `gh repo fork "${repository}" --clone=false${nameOption}${organizationOption}`;
}

export function forkProfile(config, requestedAccount) {
  const entries = Object.entries(config.profiles).filter(([, profile]) => {
    const account = profileAccount(profile);
    return Boolean(account && (!requestedAccount || account.toLowerCase() === requestedAccount.toLowerCase()));
  });
  if (entries.length === 0) {
    throw new GitHubAppError(`no GitHub App profile is configured for account ${requestedAccount ?? "the fork destination"}`);
  }
  if (entries.length > 1) {
    throw new GitHubAppError("multiple GitHub App accounts are configured; provide the destination account");
  }
  return entries[0];
}

export function invokesGitHubCli(command) {
  return command.split(/\r?\n|&&|\|\||[;|]/).some((segment) =>
    /^\s*(?:&\s*)?(?:"[^"]*[\\/]gh(?:\.exe)?"|(?:\S*[\\/])?gh(?:\.exe)?)(?=\s|$)/i.test(segment),
  );
}

/**
 * Refusal text for a direct `gh` invocation. `host` names the agent runtime so the
 * message reads correctly in both OpenCode and Claude Code.
 */
export function directGitHubCliMessage(host) {
  return `Direct gh commands are disabled in ${host}. Use github_app_gh; if it fails, fix or report the GitHub App installation access and do not retry through the shell. Use github_fork_command when a human-authenticated fork is required.`;
}

export function forkHandoffMessage({ host, profileName, profile, repository, name }) {
  const account = profileAccount(profile);
  const forkName = name ?? repository.split("/")[1];
  const organization = profile.principal?.toLowerCase() === account.toLowerCase() ? undefined : account;
  const destination = `${account}/${forkName}`;
  const command = buildForkCommand(repository, name, organization);
  return [
    "Run this command on a client authenticated with your personal GitHub account:",
    "",
    "```powershell",
    command,
    "```",
    "",
    `Expected fork: \`${destination}\``,
    `GitHub App profile: \`${profileName}\``,
    "",
    `Do not execute this command inside ${host}. Present it to the user and wait for the user to confirm that the fork completed.`,
    "After confirmation, do not ask for the user's GitHub username; use the expected fork above.",
    `Verify \`${destination}\` with \`github_app_gh\`, inspect the existing remotes, then update them with ordinary Git commands. For the standard upstream-clone layout:`,
    "",
    "```powershell",
    "git remote rename origin upstream",
    `git remote add origin "https://github.com/${destination}.git"`,
    `github-app use "${profileName}" .`,
    "```",
    "",
    "If `upstream` or the destination `origin` already exists, adjust the remotes rather than replacing unrelated configuration.",
  ].join("\n");
}

export const githubAppToolDescriptions = {
  github_app_gh: "Run GitHub CLI arguments using a short-lived, repository-scoped GitHub App token. The repository is inferred from the current directory, --repo/-R, or a gh repo target. Prefer this over running gh through the shell.",
  github_fork_command: (host) => `Render a GitHub CLI command for the user to run on a separately authenticated client, including the expected destination and post-confirmation Git remote steps. Never execute the command inside ${host}; present it and wait for the user to confirm completion.`,
};
