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
ls -s /usr/local/bin/bun /usr/local/bin/npx

apt-get update
apt-get install \
    sudo \
    curl \
    git \
    jq \
    libatomic1 \
    -y

apt-get install make gpg -y --no-install-recommends

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
ARG AZURE_FOUNDRY_PROVIDER_VERSION=0.2.0
ARG ENGRAM_VERSION=latest

ENV OPENCODE_CONFIG_DIR=/etc/opencode
ENV OPENCODE_EXPERIMENTAL=1
ENV ENGRAM_DATA_DIR=/home/bun/.local/share/opencode/engram

ENV AGENT_BROWSER_ENGINE=lightpanda

# hadolint ignore=DL3045
COPY git-export.py git-export.py

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
(
  pushd /tmp \
  && bun install "github:ophiosdev/azure-foundry-provider#v${AZURE_FOUNDRY_PROVIDER_VERSION}" \
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
)

###
# UV
uv_resolved_version=$(resolve_github_latest_version "astral-sh/uv" "${UV_VERSION:-latest}") || exit 1
uv_version="${uv_resolved_version#v}"
uv_url="https://releases.astral.sh/github/uv/releases/download/${uv_version}/uv-x86_64-unknown-linux-gnu.tar.gz"
curl -fsSL "${uv_url}" | tar -C /usr/local/bin -xvzf - --strip-components=1 --wildcards '*/uv*' || exit 1

##
# jcodemunch-mcp
uv pip install --system jcodemunch-mcp || exit 1

###
# cleanup
rm -rf /root/.bun
chown -Rh bun:bun "$(echo ~bun)"

FOE

RUN <<'FOE'
   source /etc/bash.bashrc

   skills_dir="${OPENCODE_CONFIG_DIR}/skills"
   mkdir -p "${skills_dir}"

   skill_name="humanizer"
   mkdir -p "${skills_dir}/${skill_name}"
   curl -L 'https://raw.githubusercontent.com/blader/humanizer/refs/heads/main/SKILL.md' -o "${skills_dir}/${skill_name}/SKILL.md"

   uv pip install --system "aleph-rlm[mcp]"
   skill_name="aleph"
   mkdir -p "${skills_dir}/${skill_name}"
   curl -L 'https://raw.githubusercontent.com/Hmbown/aleph/refs/heads/main/docs/prompts/aleph.md' -o "${skills_dir}/${skill_name}/SKILL.md"

   skill_name="changelog"
   python git-export.py "https://github.com/sickn33/antigravity-awesome-skills/skills/changelog-automation" "${skills_dir}/${skill_name}" --force

   skill_name="agent-browser"
   python git-export.py "https://github.com/vercel-labs/agent-browser/tree/main/skills/${skill_name}" "${skills_dir}/${skill_name}" --force

   rm -f git-export.py

   cat >"${OPENCODE_CONFIG_DIR}/opencode.json" <<-'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "engram",
    "file:///usr/local/bun/install/global/node_modules/opencode-gemini-auth"
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
        "jcodemunch-mcp", "--log-level", "DEBUG", "--log-file", "/home/bun/.local/share/opencode/log/jcodemunch.log"
      ],
      "environment": {
        "JCODEMUNCH_SHARE_SAVINGS": "0"
      },
      "enabled": false
    }
  }
}
EOF

FOE

COPY --chmod=0555 entrypoint.sh /entrypoint.sh
COPY --chmod=0555 convert-gemini.auth.ts /usr/local/bin/convert-gemini.auth.ts

USER bun:bun

RUN mise use -g --silent go@1.24 ripgrep

# Set BASH_ENV so non-interactive bash shells (spawned by OpenCode CLI) source /etc/bash.bashrc
# This ensures mise activation and PATH are available in shell commands
ENV BASH_ENV=/etc/bash.bashrc
ENV SHELL=/bin/bash

ENTRYPOINT [ "/entrypoint.sh" ]
