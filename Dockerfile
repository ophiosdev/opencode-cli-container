# hadolint ignore=DL3007
FROM oven/bun:latest

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

ENV DEBIAN_FRONTEND="noninteractive"
ARG PYTHON_VERSION="3.12"
ENV PYTHON_DIR="/usr/local/share/python/${PYTHON_VERSION}"
ENV PATH="${PATH}:${PYTHON_DIR}/bin"

# hadolint ignore=DL3008,DL3015,SC2116
RUN <<'FOE'

ln -s /usr/local/bin/bun /usr/local/bin/node
ln -s /usr/local/bin/bun /usr/local/bin/npx

apt-get update
apt-get install \
    sudo \
    curl \
    git \
    jq \
    libatomic1 \
    -y

apt-get install make gpg gpg-agent procps -y --no-install-recommends

rm -rf /var/lib/apt/lists/* /var/cache/apt

# PREPEND the script loader to /etc/bash.bashrc (before the early return for non-interactive shells)
# The default /etc/bash.bashrc has "[ -z "${PS1-}" ] && return" which exits early for non-interactive shells
{
    cat <<-'HEADER'
# script loader for /etc/bash_profile.d (prepended for non-interactive shell support)
if [ -d /etc/bash_profile.d ]; then
    shopt -s nullglob
    while IFS= read -r _script; do
        [ -f "$_script" ] && [ -r "$_script" ] && . "$_script"
    done < <(printf '%s\n' /etc/bash_profile.d/[0-9]* | sort -V)
    for _script in /etc/bash_profile.d/[!0-9]*; do
        [ -f "$_script" ] && [ -r "$_script" ] && . "$_script"
    done
    unset _script
    shopt -u nullglob
fi

HEADER
    cat /etc/bash.bashrc
} > /etc/bash.bashrc.new
mv /etc/bash.bashrc.new /etc/bash.bashrc

usermod --shell /bin/bash bun

curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Create the bash_profile.d directory and mise script
mkdir /etc/bash_profile.d

cat >/etc/bash_profile.d/mise <<-'EOF'
export PATH=/usr/local/bun/bin:$HOME/.local/bin:$PATH
# Use appropriate mise activation based on shell type
if [[ $- == *i* ]]; then
    # Interactive shell: use activate which sets up PROMPT_COMMAND hooks
    eval "$(mise activate)"
else
    # Non-interactive shell: use hook-env with --force to skip early exit check
    eval "$(mise hook-env -C $HOME -s bash --force)"
fi
EOF

mise install-into "python@${PYTHON_VERSION}" "${PYTHON_DIR}"

cat >/etc/bash_profile.d/python <<-'EOF'
export PATH="${PATH}:${PYTHON_DIR}/bin"
EOF

FOE

ARG OPENCODE_VERSION=latest
ARG CAVEMAN_VERSION=latest
ARG AZURE_FOUNDRY_PROVIDER_REF=latest
ARG PONYTAIL_VERSION=latest
ARG ENGRAM_VERSION=latest
ARG OPENCODE_BUILD_DIR=/usr/local/share/opencode-build

ENV OPENCODE_CONFIG_DIR=/etc/opencode
ENV OPENCODE_EXPERIMENTAL=1
ENV ENGRAM_DATA_DIR=/home/bun/.local/share/opencode/engram
ENV RTK_TELEMETRY_DISABLED=1

ENV AGENT_BROWSER_ENGINE=lightpanda

# hadolint ignore=DL3003,SC2164
RUN <<'FOE'

export BUN_INSTALL=/usr/local/bun
export PROVIDER_DIR=/usr/local/provider
export OPENCODE_PLUGINS_DIR="${OPENCODE_CONFIG_DIR}/plugins"

###
# Helper function to resolve 'latest' to actual version tag from GitHub API
# Usage: resolve_github_latest_version <owner>/<repo> <version>
# Returns: actual version tag (resolves 'latest' via API, otherwise returns input as-is)
#
resolve_github_latest_version() {
    local repo_slug="${1}"
    local version="${2}"

    if [ "${version}" = "latest" ]; then
        version=$(curl -fsSL "https://api.github.com/repos/${repo_slug}/releases/latest" | jq -r '.tag_name')
        if [ -z "${version}" ] || [ "${version}" = "null" ]; then
            echo "Failed to fetch latest release version for ${repo_slug} from GitHub API" >&2
            return 1
        fi
    fi
    echo "${version}"
}

mkdir -p "${BUN_INSTALL}" "${OPENCODE_CONFIG_DIR}" "${OPENCODE_PLUGINS_DIR}" "${PROVIDER_DIR}"
chmod 0777 "${OPENCODE_CONFIG_DIR}"

bun install -g "opencode-ai@${OPENCODE_VERSION}" || exit 1

###
# providers
#
# AZURE_FOUNDRY_PROVIDER_REF: if starts with 'v' → version tag, else → branch name
#
(
  azure_foundry_provider_resolved_version=$(resolve_github_latest_version "ophiosdev/azure-foundry-provider" "${AZURE_FOUNDRY_PROVIDER_REF}") || exit 1
  echo "AZURE_FOUNDRY_PROVIDER_REF=${azure_foundry_provider_resolved_version}"
  pushd /tmp \
  && bun install "github:ophiosdev/azure-foundry-provider#${azure_foundry_provider_resolved_version}" \
  && cd node_modules/azure-foundry-provider \
  && bun build --outdir=dist src/index.ts \
  && mv dist "${PROVIDER_DIR}/azure-foundry-provider" \
  && rm -rf /tmp/* \
  && popd
) || exit 1

###
# Gemini plugin
#
bun install -g 'opencode-gemini-auth@latest' || exit 1

###
# agent browser
(
  bun install -g --trust agent-browser \
  && curl -fsSL -o /usr/local/bin/lightpanda 'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux' \
  && chmod a+x /usr/local/bin/lightpanda
) || exit 1

###
# engram
#
engram_resolved_version=$(resolve_github_latest_version "Gentleman-Programming/engram" "${ENGRAM_VERSION}") || exit 1
engram_version="${engram_resolved_version#v}"
engram_archive="engram_${engram_version}_linux_amd64.tar.gz"
engram_url="https://github.com/Gentleman-Programming/engram/releases/download/${engram_resolved_version}/${engram_archive}"
(
  curl -fsSL "${engram_url}" | tar -C /usr/local/bin -xvzf - engram \
  && curl -fsSL "https://raw.githubusercontent.com/Gentleman-Programming/engram/refs/tags/${engram_resolved_version}/plugin/opencode/engram.ts" -o "${OPENCODE_PLUGINS_DIR}/engram.ts"
) || exit 1

###
# UV
uv_resolved_version=$(resolve_github_latest_version "astral-sh/uv" "${UV_VERSION:-latest}") || exit 1
uv_version="${uv_resolved_version#v}"
uv_url="https://releases.astral.sh/github/uv/releases/download/${uv_version}/uv-x86_64-unknown-linux-gnu.tar.gz"
curl -fsSL "${uv_url}" | tar -C /usr/local/bin -xvzf - --strip-components=1 --wildcards '*/uv*' || exit 1

##
# jcodemunch-mcp
jcodemunch_mcp_resolved_version=$(resolve_github_latest_version "jgravelle/jcodemunch-mcp" "${JCODEMUNCH_MCP_VERSION:-latest}") || exit 1
uv pip install --system "git+https://github.com/jgravelle/jcodemunch-mcp.git@${jcodemunch_mcp_resolved_version}" || exit 1

##
# rtk
(
  curl -fsSL "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh" \
  | RTK_INSTALL_DIR=/usr/local/bin sh
) || exit 1

curl -fsSL "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/hooks/opencode/rtk.ts" -o "${OPENCODE_PLUGINS_DIR}/rtk.ts" \
|| exit 1

##
# vercel/skills
bun install -g --trust skills@latest

###
# caveman
#
caveman_resolved_version=$(resolve_github_latest_version "JuliusBrussee/caveman" "${CAVEMAN_VERSION}") || exit 1
echo "CAVEMAN_RESOLVED_REF=${caveman_resolved_version}"
echo "${caveman_resolved_version}" > /tmp/caveman_version

mkdir -p "${OPENCODE_CONFIG_DIR}/plugins/caveman" "${OPENCODE_CONFIG_DIR}/commands" "${OPENCODE_CONFIG_DIR}/agents"

CAVEMAN_RAW_BASE="https://raw.githubusercontent.com/JuliusBrussee/caveman/refs/tags/${caveman_resolved_version}"

# AGENTS.md — always-on caveman ruleset (auto-discovered by opencode)
curl -fsSL "${CAVEMAN_RAW_BASE}/src/rules/caveman-activate.md" -o "${OPENCODE_CONFIG_DIR}/AGENTS.md" || exit 1

{
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/package.json" -o "${OPENCODE_CONFIG_DIR}/plugins/caveman/package.json"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/plugin.js" -o "${OPENCODE_CONFIG_DIR}/plugins/caveman/plugin.js"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/hooks/caveman-config.js" -o "${OPENCODE_CONFIG_DIR}/plugins/caveman/caveman-config.cjs"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/commands/caveman.md" -o "${OPENCODE_CONFIG_DIR}/commands/caveman.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/commands/caveman-commit.md" -o "${OPENCODE_CONFIG_DIR}/commands/caveman-commit.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/commands/caveman-review.md" -o "${OPENCODE_CONFIG_DIR}/commands/caveman-review.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/commands/caveman-stats.md" -o "${OPENCODE_CONFIG_DIR}/commands/caveman-stats.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/src/plugins/opencode/commands/caveman-help.md" -o "${OPENCODE_CONFIG_DIR}/commands/caveman-help.md"
  # cavecrew subagents — strip `tools:` frontmatter (opencode rejects YAML array form)
  curl -fsSL "${CAVEMAN_RAW_BASE}/agents/cavecrew-investigator.md" | sed '/^tools:/,/^[^ ]/ { /^tools:/d; /^ /d; }' > "${OPENCODE_CONFIG_DIR}/agents/cavecrew-investigator.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/agents/cavecrew-builder.md" | sed '/^tools:/,/^[^ ]/ { /^tools:/d; /^ /d; }' > "${OPENCODE_CONFIG_DIR}/agents/cavecrew-builder.md"
  curl -fsSL "${CAVEMAN_RAW_BASE}/agents/cavecrew-reviewer.md" | sed '/^tools:/,/^[^ ]/ { /^tools:/d; /^ /d; }' > "${OPENCODE_CONFIG_DIR}/agents/cavecrew-reviewer.md"
} & wait || exit 1

cat > "${OPENCODE_CONFIG_DIR}/commands/caveman-compress.md" <<'EOF'
---
description: Compress a Markdown memory file using the caveman-compress skill
---
Compress the target file with `caveman-compress`.

Input: `$ARGUMENTS`

Run the installed `caveman-compress` skill workflow against the given file path.
Preserve code, URLs, paths, commands, and structure exactly as the skill requires.
Overwrite the original file only if the compression succeeds, and keep the `.original.md` backup.
EOF

###
# ponytail
#
ponytail_resolved_version=$(resolve_github_latest_version "DietrichGebert/ponytail" "${PONYTAIL_VERSION}") || exit 1
echo "PONYTAIL_RESOLVED_REF=${ponytail_resolved_version}"

PONYTAIL_RAW_BASE="https://raw.githubusercontent.com/DietrichGebert/ponytail/refs/tags/${ponytail_resolved_version}"

mkdir -p "${OPENCODE_CONFIG_DIR}/plugins/ponytail/hooks" \
  "${OPENCODE_CONFIG_DIR}/plugins/ponytail/skills/ponytail" \
  "${OPENCODE_CONFIG_DIR}/commands" \
  "${OPENCODE_CONFIG_DIR}/skills/ponytail-review" \
  "${OPENCODE_CONFIG_DIR}/skills/ponytail-help"

curl -fsSL "${PONYTAIL_RAW_BASE}/.opencode/plugins/ponytail.mjs" \
  | sed 's|../../hooks/|./ponytail/hooks/|g' \
  > "${OPENCODE_CONFIG_DIR}/plugins/ponytail.mjs" \
  || exit 1
grep -qF './ponytail/hooks/' "${OPENCODE_CONFIG_DIR}/plugins/ponytail.mjs" \
  || {
  echo "[ponytail] FATAL: import patch failed — ../../hooks/ not replaced. Plugin version may have changed."
  exit 1;
}

{
  curl -fsSL "${PONYTAIL_RAW_BASE}/hooks/ponytail-instructions.js" -o "${OPENCODE_CONFIG_DIR}/plugins/ponytail/hooks/ponytail-instructions.js"
  curl -fsSL "${PONYTAIL_RAW_BASE}/hooks/ponytail-config.js" -o "${OPENCODE_CONFIG_DIR}/plugins/ponytail/hooks/ponytail-config.js"
  curl -fsSL "${PONYTAIL_RAW_BASE}/skills/ponytail/SKILL.md" -o "${OPENCODE_CONFIG_DIR}/plugins/ponytail/skills/ponytail/SKILL.md"
  curl -fsSL "${PONYTAIL_RAW_BASE}/.opencode/command/ponytail.md" -o "${OPENCODE_CONFIG_DIR}/commands/ponytail.md"
  curl -fsSL "${PONYTAIL_RAW_BASE}/.opencode/command/ponytail-review.md" -o "${OPENCODE_CONFIG_DIR}/commands/ponytail-review.md"
  curl -fsSL "${PONYTAIL_RAW_BASE}/skills/ponytail-review/SKILL.md" -o "${OPENCODE_CONFIG_DIR}/skills/ponytail-review/SKILL.md"
  curl -fsSL "${PONYTAIL_RAW_BASE}/skills/ponytail-help/SKILL.md" -o "${OPENCODE_CONFIG_DIR}/skills/ponytail-help/SKILL.md"
} & wait || exit 1

###
# cleanup
rm -rf /root/.bun
chown -Rh bun:bun "$(echo ~bun)"

FOE

# hadolint ignore=DL3045
COPY scripts "${OPENCODE_BUILD_DIR}/scripts"
COPY skills.yaml "${OPENCODE_BUILD_DIR}/skills.yaml"

RUN <<'FOE'
source /etc/bash.bashrc

BUN_INSTALL=/tmp/bun bun install --cwd "${OPENCODE_BUILD_DIR}/scripts" yaml || exit 1
bun "${OPENCODE_BUILD_DIR}/scripts/install-skills.ts" || exit 1

rm -rf "${OPENCODE_BUILD_DIR}"


cat >"${OPENCODE_CONFIG_DIR}/opencode.json" <<-'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "plugin": [
    "file:///usr/local/bun/install/global/node_modules/opencode-gemini-auth",
    "file:///etc/opencode/plugins/caveman"
  ],
  "mcp": {
    "engram": {
      "type": "local",
      "command": [
        "engram",
        "mcp",
        "--tools=agent"
      ],
      "enabled": true
    },
    "sequential-thinking": {
      "type": "local",
      "command": [
        "bun",
        "x",
        "@modelcontextprotocol/server-sequential-thinking"
      ],
      "enabled": false
    },
    "aleph": {
      "type": "local",
      "command": [
        "aleph",
        "--enable-actions",
        "--workspace-mode",
        "any",
        "--tool-docs",
        "concise"
      ],
      "enabled": false
    },
    "msdocs": {
      "type": "remote",
      "url": "https://learn.microsoft.com/api/mcp",
      "enabled": false
    },
    "jcodemunch": {
      "type": "local",
      "command": [
        "jcodemunch-mcp", "--log-level", "WARNING", "--log-file", "/home/bun/.local/share/opencode/log/jcodemunch.log"
      ],
      "environment": {
        "JCODEMUNCH_SHARE_SAVINGS": "0",
        "JCODEMUNCH_TRUSTED_FOLDERS": "/work"
      },
      "enabled": false
    }
  }
}
EOF

FOE

COPY --chmod=0555 scripts/entrypoint.sh /entrypoint.sh
COPY --chmod=0555 scripts/convert-gemini.auth.ts /usr/local/bin/convert-gemini.auth.ts

USER bun:bun

RUN mise use -g --silent go@1.24 ripgrep

# Set BASH_ENV so non-interactive bash shells (spawned by OpenCode CLI) source /etc/bash.bashrc
# This ensures mise activation and PATH are available in shell commands
ENV BASH_ENV=/etc/bash.bashrc
ENV SHELL=/bin/bash

ENTRYPOINT [ "/entrypoint.sh" ]
