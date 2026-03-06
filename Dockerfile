# hadolint ignore=DL3007
FROM oven/bun:latest

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

ENV DEBIAN_FRONTEND=noninteractive

# hadolint ignore=DL3008,DL3015,SC2116
RUN <<'FOE'

apt-get update
apt-get install \
    sudo \
    curl \
    git \
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

chown -Rh bun:bun "$(echo ~bun)"

FOE

COPY --chmod=0555 entrypoint.sh /entrypoint.sh

ARG OPENCODE_VERSION=latest
ENV OPENCODE_CONFIG_DIR=/etc/opencode

# hadolint ignore=DL3003,SC2164
RUN <<'FOE'

export BUN_INSTALL=/usr/local/bun
export PROVIDER_DIR=/usr/local/provider

mkdir -p "${BUN_INSTALL}" "${OPENCODE_CONFIG_DIR}" "${PROVIDER_DIR}"

bun install -g "opencode-ai@${OPENCODE_VERSION}" || exit 1

###
# providers
#
pushd /tmp

bun install "github:ophiosdev/azure-foundry-provider" || exit 1
cd node_modules/azure-foundry-provider || exit 1
bun build --outdir=dist src/index.ts || exit 1
mv dist "${PROVIDER_DIR}/azure-foundry-provider"
rm -rf /tmp/*

popd || exit 1

EOF

rm -rf /root/.bun

FOE

USER bun

RUN mise use -g --silent python@3.12.12 go@1.24 ripgrep uv

# hadolint ignore=DL3045
COPY --chown=bun:bun git-export.py git-export.py

ENV XDG_CONFIG_HOME=/home/bun/.config

RUN <<'FOE'
   source /etc/bash.bashrc

   skills_dir="${XDG_CONFIG_HOME}/opencode/skills"
   mkdir -p "${skills_dir}"

   skill_name="humanizer"
   mkdir -p "${skills_dir}/${skill_name}"
   curl -L 'https://raw.githubusercontent.com/blader/humanizer/refs/heads/main/SKILL.md' -o "${skills_dir}/${skill_name}/SKILL.md"

   uv pip install --system "aleph-rlm[mcp]"
   skill_name="aleph"
   mkdir -p "${skills_dir}/${skill_name}"
   curl -L 'https://raw.githubusercontent.com/Hmbown/aleph/refs/heads/main/docs/prompts/aleph.md' -o "${skills_dir}/${skill_name}/SKILL.md"

   skill_name="changelog"
   python git-export.py https://github.com/sickn33/antigravity-awesome-skills/skills/changelog-automation "${skills_dir}/${skill_name}" --force

   rm -f git-export.py
FOE

# Set BASH_ENV so non-interactive bash shells (spawned by OpenCode CLI) source /etc/bash.bashrc
# This ensures mise activation and PATH are available in shell commands
ENV BASH_ENV=/etc/bash.bashrc
ENV SHELL=/bin/bash

ENTRYPOINT [ "/entrypoint.sh" ]
