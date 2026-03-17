#!/usr/bin/env bash

###
# Ensure MISE configuration is loaded
source /etc/bash.bashrc

GEMINI_CREDS_PATH="${GEMINI_OAUTH_CREDS_PATH:-$HOME/.gemini/oauth_creds.json}"
CONVERTER_PATH="${CONVERTER_PATH:-/usr/local/bin/convert-gemini.auth.ts}"

if [[ -f "${GEMINI_CREDS_PATH}" ]]; then
  bun "${CONVERTER_PATH}"
fi

exec /usr/local/bin/opencode "$@"
