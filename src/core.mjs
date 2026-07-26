import { spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const configRoot = join(homedir(), ".config", "github-apps");
export const configPath = join(configRoot, "config.json");
export const keysPath = join(configRoot, "keys");

export class GitHubAppError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubAppError";
  }
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function runGit(arguments_, cwd) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  if (result.error) throw new GitHubAppError(result.error.message);
  if (result.status !== 0) throw new GitHubAppError(result.stderr.trim() || "git command failed");
  return result.stdout.trim();
}

function optionalGit(arguments_, cwd) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { profiles: {} };
    throw new GitHubAppError(`cannot read ${configPath}: ${error.message}`);
  }
}

export async function saveConfig(config) {
  await mkdir(configRoot, { recursive: true });
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);
}

export function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || !value) throw new GitHubAppError(`invalid option ${key ?? ""}`);
    const name = key.slice(2);
    options[name] = value;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (!options[name]) throw new GitHubAppError(`missing --${name}`);
  }
}

export async function addProfile(arguments_) {
  const options = parseOptions(arguments_);
  requireOptions(options, ["name", "account", "app-id", "installation-id", "slug", "bot-user-id", "principal", "key"]);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(options.account)) {
    throw new GitHubAppError("account must be a GitHub user or organization login");
  }
  const sourceKey = resolve(options.key);
  const destinationKey = join(keysPath, `${options.name}.pem`);
  await mkdir(keysPath, { recursive: true });
  await copyFile(sourceKey, destinationKey);
  await chmod(destinationKey, 0o600);
  const config = await loadConfig();
  config.profiles[options.name] = {
    account: options.account,
    appId: options["app-id"],
    installationId: options["installation-id"],
    slug: options.slug,
    botUserId: options["bot-user-id"],
    principal: options.principal,
    privateKey: destinationKey,
  };
  await saveConfig(config);
  return { name: options.name, profile: config.profiles[options.name] };
}

export async function setPrincipal(name, principal) {
  if (!name || !principal) throw new GitHubAppError("usage: github-app set-principal PROFILE GITHUB_LOGIN");
  const config = await loadConfig();
  const profile = config.profiles[name];
  if (!profile) throw new GitHubAppError(`unknown profile ${name}`);
  profile.principal = principal;
  await saveConfig(config);
  return profile;
}

export async function setAccount(name, account, dependencies = {}) {
  if (!name || !account) throw new GitHubAppError("usage: github-app set-account PROFILE OWNER");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account)) {
    throw new GitHubAppError("account must be a GitHub user or organization login");
  }
  const config = dependencies.config ?? await loadConfig();
  const profile = config.profiles[name];
  if (!profile) throw new GitHubAppError(`unknown profile ${name}`);
  profile.account = account;
  delete profile.repositories;
  await (dependencies.saveConfigImpl ?? saveConfig)(config);
  return profile;
}

export function repositoryFromRemote(remote) {
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1]?.replace(/\.git$/, "");
}

export function profileAccount(profile) {
  if (profile.account) return profile.account;
  const accounts = new Set(profile.repositories?.map((entry) => entry.split("/")[0].toLowerCase()));
  return accounts.size === 1 ? profile.repositories[0].split("/")[0] : undefined;
}

export function profileRoutesRepository(profile, repository) {
  const account = profileAccount(profile);
  const owner = repository.split("/")[0];
  return Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());
}

export function findProfileForRepository(config, repository) {
  const entries = Object.entries(config.profiles).filter(([, profile]) => profileRoutesRepository(profile, repository));
  if (entries.length > 1) {
    throw new GitHubAppError(`${repository} matches multiple GitHub App profiles`);
  }
  return entries[0];
}

export async function useProfile(name, repositoryPath = ".") {
  if (!name) throw new GitHubAppError("usage: github-app use PROFILE [REPOSITORY_PATH]");
  const config = await loadConfig();
  const profile = config.profiles[name];
  if (!profile) throw new GitHubAppError(`unknown profile ${name}`);
  const cwd = resolve(repositoryPath);
  const repository = repositoryFromRemote(runGit(["remote", "get-url", "origin"], cwd));
  if (!repository) throw new GitHubAppError("origin is not a GitHub repository");
  if (!profileRoutesRepository(profile, repository)) {
    throw new GitHubAppError(`${repository} is not owned by account ${profileAccount(profile) ?? "unconfigured"}`);
  }
  runGit(["config", "--local", "user.name", `${profile.slug}[bot]`], cwd);
  runGit(["config", "--local", "user.email", `${profile.botUserId}+${profile.slug}[bot]@users.noreply.github.com`], cwd);
  runGit(["remote", "set-url", "origin", `https://github.com/${repository}.git`], cwd);
  return { cwd, repository, profile };
}

export async function createToken(profile, repository, dependencies = {}) {
  if (!repository || !profileRoutesRepository(profile, repository)) {
    throw new GitHubAppError(`${repository ?? "repository"} is not owned by this GitHub App profile's account`);
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: profile.appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(await readFileImpl(profile.privateKey), "base64url");
  const repositoryName = repository.slice(repository.indexOf("/") + 1);
  const response = await fetchImpl(`https://api.github.com/app/installations/${profile.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${unsigned}.${signature}`,
      "Content-Type": "application/json",
      "User-Agent": "github-app-credential-helper",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ repositories: [repositoryName] }),
  });
  const body = await response.json();
  if (!response.ok || !body.token) {
    throw new GitHubAppError(body.message || `GitHub returned HTTP ${response.status}`);
  }
  return body.token;
}

export function parseCredentialInput(input) {
  return Object.fromEntries(input.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

export async function credentialForRequest(request, dependencies = {}) {
  if (request.host !== "github.com" || !request.path) return undefined;
  const repository = request.path.replace(/^\//, "").replace(/\.git$/, "");
  const config = dependencies.config ?? await loadConfig();
  const entry = findProfileForRepository(config, repository);
  if (!entry) return { quit: true };
  const [, profile] = entry;
  return {
    username: "x-access-token",
    password: await createToken(profile, repository, dependencies),
  };
}

export async function repositoryProfile(repositoryPath = ".", dependencies = {}) {
  const cwd = resolve(repositoryPath);
  const remote = (dependencies.optionalGitImpl ?? optionalGit)(["remote", "get-url", "origin"], cwd);
  const repository = remote && repositoryFromRemote(remote);
  const config = dependencies.config ?? await loadConfig();
  const entry = repository && findProfileForRepository(config, repository);
  return { cwd, repository, name: entry?.[0], profile: entry?.[1] };
}

export async function configuredRepositoryProfile(repository, repositoryPath = ".", dependencies = {}) {
  const normalizedRepository = repository.replace(/^\//, "").replace(/\.git$/, "");
  const config = dependencies.config ?? await loadConfig();
  const entry = findProfileForRepository(config, normalizedRepository);
  return {
    cwd: resolve(repositoryPath),
    repository: normalizedRepository,
    name: entry?.[0],
    profile: entry?.[1],
  };
}

function replaceMe(value, principal) {
  return value.split(",").map((entry) => entry === "@me" ? principal : entry).join(",");
}

export function rewriteGitHubArguments(arguments_, principal) {
  const argumentsCopy = [...arguments_];
  const isIssueEdit = argumentsCopy[0] === "issue" && argumentsCopy[1] === "edit";
  const isIssueCreate = argumentsCopy[0] === "issue" && argumentsCopy[1] === "create";
  const supportedOptions = isIssueEdit
    ? new Set(["--add-assignee"])
    : isIssueCreate
      ? new Set(["--assignee", "-a"])
      : new Set();

  for (let index = 0; index < argumentsCopy.length; index += 1) {
    const argument = argumentsCopy[index];
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!supportedOptions.has(option)) continue;

    const valueIndex = equalsIndex === -1 ? index + 1 : index;
    const value = equalsIndex === -1 ? argumentsCopy[valueIndex] : argument.slice(equalsIndex + 1);
    if (!value?.split(",").includes("@me")) continue;
    if (!principal) throw new GitHubAppError("@me requires a human principal; run github-app set-principal PROFILE GITHUB_LOGIN");

    const replacement = replaceMe(value, principal);
    argumentsCopy[valueIndex] = equalsIndex === -1 ? replacement : `${option}=${replacement}`;
  }

  return argumentsCopy;
}

export function validateGitHubArguments(arguments_) {
  if (["alias", "auth", "extension"].includes(arguments_[0])) {
    throw new GitHubAppError(`gh ${arguments_[0]} is unavailable through GitHub App authentication`);
  }
}

export async function runGitHubCli(arguments_, repositoryPath = ".", options = {}) {
  if (arguments_.length === 0) throw new GitHubAppError("no gh arguments supplied");
  validateGitHubArguments(arguments_);
  const selection = options.repository
    ? await (options.configuredRepositoryProfileImpl ?? configuredRepositoryProfile)(options.repository, repositoryPath)
    : await (options.repositoryProfileImpl ?? repositoryProfile)(repositoryPath);
  const { cwd, repository, profile } = selection;
  if (!repository || !profile) throw new GitHubAppError("repository owner is not configured as a GitHub App profile account");
  const rewrittenArguments = rewriteGitHubArguments(arguments_, profile.principal);
  const token = await (options.createTokenImpl ?? createToken)(profile, repository);
  const result = (options.spawnSyncImpl ?? spawnSync)("gh", rewrittenArguments, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: {
      ...(options.env ?? process.env),
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_REPO: repository,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.error) throw new GitHubAppError(result.error.message);
  return { ...result, cwd, repository, arguments: rewrittenArguments };
}
