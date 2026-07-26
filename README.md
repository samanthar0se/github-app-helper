# GitHub App Helper

Local Git and GitHub CLI authentication through short-lived GitHub App installation tokens. The helper keeps personal credentials absent, routes repositories to an App profile by owner account, and lets GitHub's installation access enforce repository authorization.

## Files and ownership

- `src/core.mjs` contains reusable configuration, repository, token, and GitHub CLI logic.
- `src/github-app.mjs` is the thin command-line entrypoint.
- `src/opencode-plugin.mjs` provides repository-specific Git authentication and the `github_app_gh` tool; `src/opencode-plugin-core.mjs` contains its testable implementation.
- `scripts/install.sh` installs a generated copy into `~/.local/bin`.
- `~/.config/github-apps/config.json` contains machine-local profile configuration.
- `~/.config/github-apps/keys/` contains private App keys.
- Configuration, keys, and generated installation files must never be committed.

The installed `~/.local/bin/github-app.mjs` is not authoritative. Make changes here, run tests, then reinstall.

## Install

From Git Bash:

```bash
npm install
npm test
./scripts/install.sh
```

The launcher defaults to Pi's managed Node executable. Override it when necessary:

```bash
PI_NODE_EXE=/path/to/node.exe ./scripts/install.sh
```

## Profile setup

Create a profile with its App identity, installation account, human principal, and private key:

```bash
github-app add \
  --name samantha-clanker \
  --account samanthar0se \
  --app-id APP_ID \
  --installation-id INSTALLATION_ID \
  --slug samantha-clanker \
  --bot-user-id BOT_USER_ID \
  --principal samanthar0se \
  --key /secure/path/app.pem
```

Set or migrate the human principal independently:

```bash
github-app set-principal samantha-clanker samanthar0se
```

Migrate a legacy profile that still contains a repository list:

```bash
github-app set-account samantha-clanker samanthar0se
```

Assign a repository and inspect its effective identity before Git work:

```bash
github-app use samantha-clanker C:/git/example
github-app inspect C:/git/example
```

Run GitHub CLI repository operations through an ephemeral installation token:

```bash
github-app gh C:/git/example -- issue list
```

The authenticated wrapper rejects `gh auth`, `gh alias`, and `gh extension` commands because they can expose the token or pass it to arbitrary child code.

## `@me` compatibility

GitHub App installation tokens do not have an authenticated human user, so GitHub CLI cannot resolve `@me` itself. Some agent skills intentionally express a claim as:

```bash
gh issue edit 42 --add-assignee @me
```

The helper preserves that portable skill contract. For issue-assignment options only, it translates `@me` to the profile's configured human principal before invoking `gh`. The API request still authenticates as the GitHub App; GitHub records the App as the actor and the human as the assignee.

The translation is deliberately narrow:

- `gh issue edit ... --add-assignee @me`
- `gh issue create ... --assignee @me`
- `gh issue create ... -a @me`

It does not rewrite comments, issue bodies, arbitrary command arguments, or Git attribution. If an assignment uses `@me` without a configured principal, the helper fails before contacting GitHub.

## Security model

- Installation tokens are minted on demand, scoped by GitHub to the matched repository, and are not persisted.
- Git credentials are returned only when a repository owner matches a configured App installation account.
- GitHub CLI receives tokens only in its child-process environment.
- Commit identity remains the App bot identity.
- Human assignment is routing metadata, not user impersonation.
- The App still requires the relevant repository permissions, including `Issues: write` for assignments.

## OpenCode plugin

Install the helper first, then load the local plugin from the global OpenCode config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///C:/git/github-app-helper/src/opencode-plugin.mjs"
  ]
}
```

For repositories owned by a configured account, the plugin's `shell.env` hook clears inherited Git credential helpers, installs `github-app credential`, enables `credential.useHttpPath`, and disables terminal prompting. It does not expose `GH_TOKEN` or `GITHUB_TOKEN` to shell commands. Agents should use `github_app_gh` instead of invoking `gh` through the shell.

The tool normally selects the repository from the session directory. From an unrelated directory, it can infer the repository from `--repo`, `-R`, or a `gh repo` target. Its optional `repository` argument provides an explicit override. The tool validates the repository owner against the configured account before asking GitHub for a token scoped to that repository.

### Fork handoff

GitHub requires user authentication to fork a public repository when the App is not installed on its source account. The `github_fork_command` tool renders a command for the user to copy to a separately authenticated client, for example:

```powershell
gh repo fork "openchamber/openchamber" --clone=false
```

The tool never executes the command or accesses user credentials. It includes the expected destination account, App profile, and post-confirmation Git remote commands, then instructs the agent to wait. After the fork exists, the agent verifies the expected repository through `github_app_gh`, updates `origin` and `upstream` with ordinary Git commands, and applies the bot commit identity with `github-app use`. Account-based routing applies immediately; GitHub's App installation access determines whether GitHub operations are authorized.

The plugin blocks direct `gh` invocations through OpenCode's shell tool. If `github_app_gh` fails, the agent must fix or report the App installation access rather than falling back to user-authenticated GitHub CLI commands.

Quit and restart OpenCode after changing its config or this plugin file.

## Maintenance

1. Edit the files under `src/`.
2. Add or update tests under `test/`.
3. Run `npm test`.
4. Run `./scripts/install.sh`.
5. Verify with `github-app status` and `github-app inspect <repo>`.

Do not edit the installed MJS file directly; reinstall it from this repository.
