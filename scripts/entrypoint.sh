#!/usr/bin/env bash

###
# Ensure MISE configuration is loaded
source /etc/bash.bashrc

: "${LISTEN_ADDR:=127.0.0.1:8899}"
export LISTEN_ADDR

###
# Proxy lockdown (entrypoint-only, runs at container start): llm-proxy takes
# ALL container traffic, so HTTP(S)_PROXY must point at it — chain llm-proxy
# itself upstream via UPSTREAM_PROXY instead.
_listen="${LISTEN_ADDR}"
[[ "${_listen}" == :* ]] && _listen="127.0.0.1${_listen}"
_proxy_url="http://${_listen}"
for _proxy_var in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
  if [[ "${!_proxy_var:-}" != "${_proxy_url}" ]]; then
    if [[ -n "${!_proxy_var:-}" ]]; then
      echo "WARNING: ${_proxy_var} is set to a custom proxy; overriding it with ${_proxy_url}. Chain llm-proxy upstream via UPSTREAM_PROXY instead." >&2
    fi
    export "${_proxy_var}=${_proxy_url}"
  fi
done
for _proxy_var in ALL_PROXY all_proxy; do
  if [[ -n "${!_proxy_var:-}" ]]; then
    echo "WARNING: ${_proxy_var} is set; ignoring it. Chain llm-proxy upstream via UPSTREAM_PROXY instead." >&2
    unset "${_proxy_var}"
  fi
done

# Plain-HTTP traffic to llm-proxy must never be sent to an outbound proxy.
_enforced_no_proxy="localhost,127.0.0.1"
for _proxy_var in NO_PROXY no_proxy; do
  if [[ -n "${!_proxy_var:-}" && "${!_proxy_var}" != "${_enforced_no_proxy}" ]]; then
    echo "WARNING: ${_proxy_var} is set; overriding it with ${_enforced_no_proxy}." >&2
  fi
  export "${_proxy_var}=${_enforced_no_proxy}"
done
unset _proxy_var _listen _proxy_url _enforced_no_proxy

# UPSTREAM_URL is optional: when set, origin-form requests go there; when
# unset, the proxy connects directly to whatever host each (absolute-form)
# request names. Point your Azure provider baseURL at
# http://127.0.0.1:8899/openai/v1 to route through it.

###
# Start llm-proxy (required for Azure TLS) and wait for its port.
if ! command -v llm-proxy >/dev/null 2>&1; then
  echo "ERROR: llm-proxy binary not found on PATH; refusing to start without Azure TLS fix." >&2
  exit 1
fi

# No log files by default: LLM_LOG_FILE unset/empty disables JSONL call
# logging, and without LLM_PROXY_LOG the proxy logs to container stdout/stderr.
if [[ -n "${LLM_LOG_FILE:-}" ]]; then
  mkdir -p "$(dirname "${LLM_LOG_FILE}")" 2>/dev/null || true
  export LLM_LOG_FILE
fi

if [[ -n "${LLM_PROXY_LOG:-}" ]]; then
  mkdir -p "$(dirname "${LLM_PROXY_LOG}")" 2>/dev/null || true
  llm-proxy >>"${LLM_PROXY_LOG}" 2>&1 &
else
  llm-proxy &
fi
_llm_proxy_pid=$!

_llm_proxy_port="${LISTEN_ADDR##*:}"
for _i in $(seq 1 100); do
  if (echo >"/dev/tcp/127.0.0.1/${_llm_proxy_port}") 2>/dev/null; then
    break
  fi
  if ! kill -0 "${_llm_proxy_pid}" 2>/dev/null; then
    echo "ERROR: llm-proxy exited before listening on ${LISTEN_ADDR}. See ${LLM_PROXY_LOG:-container logs}." >&2
    exit 1
  fi
  sleep 0.1
done
if ! (echo >"/dev/tcp/127.0.0.1/${_llm_proxy_port}") 2>/dev/null; then
  echo "ERROR: llm-proxy did not listen on ${LISTEN_ADDR} in time. See ${LLM_PROXY_LOG:-container logs}." >&2
  exit 1
fi
unset _proxy_var _enforced_no_proxy _llm_proxy_pid _llm_proxy_port _i

GEMINI_CREDS_PATH="${GEMINI_OAUTH_CREDS_PATH:-$HOME/.gemini/oauth_creds.json}"
CONVERTER_PATH="${CONVERTER_PATH:-/usr/local/bin/convert-gemini.auth.ts}"

if [[ -f "${GEMINI_CREDS_PATH}" ]]; then
  bun "${CONVERTER_PATH}"
fi

exec /usr/local/bin/opencode "$@"
