# OpenCode CLI Container<!-- omit from toc -->

- [Container Architecture](#container-architecture)
- [Building the Container Image](#building-the-container-image)
  - [Build Arguments](#build-arguments)
- [Authentication Setup](#authentication-setup)
  - [Reusing Existing Gemini CLI Authentication](#reusing-existing-gemini-cli-authentication)
  - [Manual Gemini Authentication in the Container](#manual-gemini-authentication-in-the-container)
  - [Environment File Option](#environment-file-option)
  - [Important Environment Variables](#important-environment-variables)
  - [Verifying Authentication](#verifying-authentication)
- [Azure Foundry Provider](#azure-foundry-provider)
- [Runtime Behavior](#runtime-behavior)
- [Working with OpenCode from the Container](#working-with-opencode-from-the-container)
  - [Basic Usage Pattern](#basic-usage-pattern)
  - [Volume Mounts Explained](#volume-mounts-explained)
  - [Working Directory Context](#working-directory-context)
- [Usage Examples](#usage-examples)
  - [Interactive Session](#interactive-session)
  - [Single Command Execution](#single-command-execution)
  - [Environment File Usage](#environment-file-usage)
  - [Shell Alias for Convenience](#shell-alias-for-convenience)
- [Included Tooling and Skills](#included-tooling-and-skills)
- [Release Model](#release-model)
- [Repository Structure](#repository-structure)
- [Development and Validation](#development-and-validation)
- [Troubleshooting](#troubleshooting)
  - [Authentication and Config Issues](#authentication-and-config-issues)
  - [File Access Issues](#file-access-issues)
  - [Build and Runtime Issues](#build-and-runtime-issues)

A containerized OpenCode CLI environment with bundled runtime tooling, provider integrations,
and reusable OpenCode skills. The image ships with sensible defaults so you can start working in
local projects quickly while still mounting your own workspace, credentials, and persisted user
state from the host.

## Container Architecture

- **Prepared startup flow**: The entrypoint loads the container shell environment before launching `opencode`
- **Bun-based image**: Uses `oven/bun:latest` as the base image and installs `opencode-ai`
- **Consistent shell tooling**: Uses shell bootstrap and `BASH_ENV` so command execution sees the same prepared environment
- **Curated additions**: Bundles Azure Foundry support, memory/context tooling, and reusable skills

## Building the Container Image

Build from the provided Dockerfile:

```bash
docker build -t opencode-cli:dev .
```

You can also use the included `Makefile`:

```bash
make build
```

### Build Arguments

Customize the main image component versions and local tag as needed:

```bash
docker build \
  --build-arg OPENCODE_VERSION=latest \
  --build-arg AZURE_FOUNDRY_PROVIDER_VERSION=0.2.0 \
  --build-arg ENGRAM_VERSION=v1.9.1 \
  -t opencode-cli:dev .
```

With `make`:

```bash
make build IMAGE=opencode-cli TAG=dev OPENCODE_VERSION=latest
```

The Dockerfile also accepts `AZURE_FOUNDRY_PROVIDER_VERSION` and `ENGRAM_VERSION` if you want to
override the bundled provider or memory-tooling version during a direct `docker build`.

## Authentication Setup

The image includes default OpenCode configuration and helper integrations so it works out of the
box, but you should still mount host directories for practical day-to-day use. In most setups,
mounting your host home directory lets OpenCode state, credentials, and memory-related data
persist across runs.

Typical run pattern:

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  opencode-cli:dev
```

This gives the container access to:

- `/home/bun` for OpenCode config and any persisted credentials
- `/home/bun/.local/share/opencode` through the home mount for persisted local OpenCode and memory-related state
- `/work` for the project you want OpenCode to read and modify

### Reusing Existing Gemini CLI Authentication

If you already authenticated with `gemini-cli` on the host, the container can reuse that login
automatically.

At startup, `entrypoint.sh` checks whether `~/.gemini/oauth_creds.json` exists inside the
container. If it does, the Bun script `convert-gemini.auth.ts` converts that Gemini OAuth state
into OpenCode's auth store at `~/.local/share/opencode/auth.json`.

Typical run pattern:

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  opencode-cli:dev
```

With that home-directory mount:

- host `~/.gemini/oauth_creds.json` becomes available in the container at `/home/bun/.gemini/oauth_creds.json`
- the entrypoint converts it into OpenCode auth automatically before launching `opencode`
- existing entries in `~/.local/share/opencode/auth.json` are preserved and only the `google` provider entry is updated

Notes:

- If `~/.gemini/oauth_creds.json` is not present, startup stays silent and OpenCode launches normally
- If the Gemini credentials file exists but is malformed or missing required token fields, container startup fails so the problem is visible
- The converter path inside the image is `/usr/local/bin/convert-gemini.auth.ts`

### Manual Gemini Authentication in the Container

If you do not already have reusable Gemini CLI credentials on the host, you can authenticate
manually from inside the container with the `opencode-gemini-auth` plugin.

Start the container with a bash shell instead of the normal entrypoint:

```bash
docker run -it --rm \
  --entrypoint bash \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  opencode-cli:dev
```

Then run the login flow manually inside the container:

```bash
opencode auth login
```

In the OpenCode prompt flow:

- select `Google`
- select `OAuth with Google (Gemini CLI)`
- complete the browser-based authorization flow

If you are running the container in an environment where the browser callback cannot be completed
automatically, use the fallback flow described by the plugin and paste the redirected callback URL
or authorization code when prompted.

After successful login, the credential is stored in your mounted home directory under OpenCode's
data path, so future container runs can reuse it:

- `/home/bun/.local/share/opencode/auth.json` for provider auth
- `/home/bun/.config/opencode` for config

Once this has been done once, subsequent normal container starts can use the stored OpenCode auth
directly, without repeating the manual login flow.

### Environment File Option

If your OpenCode setup depends on provider-specific environment variables, keep them in a local
env file instead of placing secrets directly on the command line.

```bash
install -m 600 /dev/null .env
${EDITOR:-vi} .env

docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev
```

Security tips:

- Keep `.env` files out of version control
- Restrict permissions to the current user only
- Prefer short-lived credentials where possible

### Important Environment Variables

The exact variables depend on the provider configuration you use with OpenCode. This image does
not hardcode credentials, so pass provider settings at runtime with `-e` or `--env-file`.

The image also includes default configuration under `/etc/opencode`, so most users only need to
provide environment variables and volume mounts rather than build up the entire runtime setup from
scratch.

Common patterns include:

- OpenAI-compatible endpoints and API keys
- Azure-related endpoint, deployment, and credential variables
- Any custom variables required by OpenCode providers you enable in your config

### Verifying Authentication

Once your configuration is mounted and any required variables are provided, verify that the
container starts correctly:

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev --help
```

If your setup is correct, the CLI should start without basic configuration errors. Use a real
provider-backed command when you need to verify credentials end to end.

## Azure Foundry Provider

The image builds and installs the `azure-foundry-provider` package during the Docker build and
places the compiled provider under `/usr/local/provider/azure-foundry-provider`.

This means the container is prepared for Azure Foundry-oriented OpenCode setups without requiring
you to compile the provider on first run. Provider credentials and runtime configuration are still
supplied by your OpenCode config and environment variables.

The image also bundles additional helper integrations for memory and large-context workflows, so
common local coding setups can start with a useful default baseline.

## Runtime Behavior

The container does a small amount of runtime preparation before launching OpenCode:

- It loads the shell environment through the entrypoint before starting the CLI
- It uses `BASH_ENV` so non-interactive shell commands inherit the prepared toolchain environment
- It enables OpenCode experimental features by default with `OPENCODE_EXPERIMENTAL=1`

This helps keep CLI sessions and tool-invoked shell commands consistent inside the container.

## Working with OpenCode from the Container

For normal usage, mount both your home directory and the current project directory.

### Basic Usage Pattern

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev [OPENCODE_ARGS]
```

Replace `[OPENCODE_ARGS]` with the arguments supported by your installed `opencode-ai` version.

### Volume Mounts Explained

- `-v $HOME:/home/bun`: Persists OpenCode config, credentials, and memory/history data stored under the OpenCode data directory
- `-v ${PWD}:/work`: Mounts your current project into the container working directory
- `--env-file .env`: Supplies provider credentials and runtime settings without exposing them in shell history
- `--rm`: Removes the container after the process exits
- `-it`: Provides an interactive terminal for CLI workflows

### Working Directory Context

The container runs in `/work`, which maps to your current host directory. This means:

- Project files are immediately available to OpenCode
- Files created or edited by OpenCode are written back to your local directory
- Relative paths behave as expected inside the container

## Usage Examples

### Interactive Session

Start an interactive OpenCode session in the current project:

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev
```

### Single Command Execution

Run a one-off command such as help or version output:

```bash
docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev --version
```

### Environment File Usage

If you want to keep project-local settings, create a dedicated env file and reuse it:

```bash
install -m 600 /dev/null .env
${EDITOR:-vi} .env

docker run -it --rm \
  -v $HOME:/home/bun \
  -v ${PWD}:/work \
  --env-file .env \
  opencode-cli:dev --help
```

### Shell Alias for Convenience

Create a short alias for daily use:

```bash
# Add to your ~/.bashrc or ~/.zshrc
alias opencodec='docker run -it --rm -v $HOME:/home/bun -v ${PWD}:/work --env-file .env opencode-cli:dev'

# Then use simply:
opencodec --help
opencodec
```

## Included Tooling and Skills

The image currently installs or bundles the following pieces during build:

- `opencode-ai`
- `mise`
- shell bootstrap for interactive and non-interactive command execution
- default OpenCode configuration under `/etc/opencode`
- `engram` for persisted memory-oriented workflows
- `aleph` tooling for large-context local analysis workflows
- local MCP-backed integrations available by default
- `python`
- `go`
- `ripgrep`
- `uv`
- `git`
- `sudo`, `curl`, `gpg`, `make`
- Azure Foundry provider build output
- OpenCode skills for `humanizer`, `aleph`, and changelog automation

The repository also includes `git-export.py`, a helper script that exports a single directory from
a GitHub repository using a treeless, sparse clone workflow.

## Release Model

This repo publishes container images to GitHub Container Registry from version tags.

- `create-linked-release.yml` checks the latest matching upstream release on a schedule and creates a local tag when a new one appears
- `build-and-deploy.yml` runs on `v*` tags, validates semver, and publishes the image to `ghcr.io/ophiosdev/opencode-cli`
- Published tags include semver variants, a commit SHA tag, and `latest` when enabled for the default branch

## Repository Structure

- `Dockerfile`: Builds the OpenCode container image and installs providers, tools, and skills
- `entrypoint.sh`: Loads shell environment and starts `opencode`
- `git-export.py`: Sparse GitHub directory export helper
- `Makefile`: Convenience targets for local image build and cleanup
- `.github/workflows/`: PR validation, release sync, and registry publishing workflows
- `.mise.toml`: Local tool definitions for linting and validation utilities

## Development and Validation

The repo uses `pre-commit` for lightweight validation of committed files.

Configured checks include:

- General file hygiene checks from `pre-commit-hooks`
- YAML linting with `yamllint`
- Dockerfile linting with `hadolint`
- Markdown linting with `markdownlint-cli2`
- GitHub Actions validation with `actionlint`
- Spelling checks with `typos`

The pull request workflow always runs pre-commit checks and also performs a Docker build smoke
test when `Dockerfile` changes.

## Troubleshooting

### Authentication and Config Issues

- Repeated setup prompts: ensure `-v $HOME:/home/bun` is present so config persists
- Missing credentials: confirm required provider variables are passed with `-e` or `--env-file`
- Startup config failures: run `opencode-cli:dev --help` first to confirm the base container starts cleanly
- Memory/history not persisting: confirm your `/home/bun` mount is present so OpenCode state survives container recreation

### File Access Issues

- Project files not visible: confirm `-v ${PWD}:/work` is included
- Output files not appearing locally: check that your command is operating inside `/work`
- Permission mismatches: inspect ownership on your mounted directories and rebuild or adjust runtime strategy if needed

### Build and Runtime Issues

- Build failures fetching dependencies: verify network access to npm, GitHub, and other upstream sources used in the Docker build
- Provider or skill changes upstream: rebuild the image to refresh fetched components
- Command invocation errors: place OpenCode arguments after the image name and use `--help` to confirm supported flags
