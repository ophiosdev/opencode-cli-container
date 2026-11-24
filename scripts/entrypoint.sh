#!/usr/bin/env bash

###
# Ensure MISE configuration is loaded
source /etc/bash.bashrc

: "${LLM_PROXY_LISTEN_ADDR:=127.0.0.1:8899}"
export LLM_PROXY_LISTEN_ADDR

# LLM_PROXY_ENABLED=off (or 0/false/no) disables the proxy entirely: no env
# enforcement, no startup.
case "${LLM_PROXY_ENABLED,,}" in
  off|0|false|no) _llm_proxy_off=1;;
esac
if [[ "${_llm_proxy_off:-}" == "1" ]]; then
  echo "llm-proxy disabled via LLM_PROXY_ENABLED=off." >&2
  unset _llm_proxy_off
else
  ###
  # Proxy lockdown (entrypoint-only, runs at container start): llm-proxy takes
  # ALL container traffic, so HTTP(S)_PROXY must point at it — chain llm-proxy
  # itself upstream via LLM_PROXY_UPSTREAM_PROXY instead.
  _listen="${LLM_PROXY_LISTEN_ADDR}"
  [[ "${_listen}" == :* ]] && _listen="127.0.0.1${_listen}"
  _proxy_url="http://${_listen}"
  for _proxy_var in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
    if [[ "${!_proxy_var:-}" != "${_proxy_url}" ]]; then
      if [[ -n "${!_proxy_var:-}" ]]; then
        echo "WARNING: ${_proxy_var} is set to a custom proxy; overriding it with ${_proxy_url}. Chain llm-proxy upstream via LLM_PROXY_UPSTREAM_PROXY instead." >&2
      fi
      export "${_proxy_var}=${_proxy_url}"
    fi
  done
  for _proxy_var in ALL_PROXY all_proxy; do
    if [[ -n "${!_proxy_var:-}" ]]; then
      echo "WARNING: ${_proxy_var} is set; ignoring it. Chain llm-proxy upstream via LLM_PROXY_UPSTREAM_PROXY instead." >&2
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

  # LLM_PROXY_UPSTREAM_URL is optional: when set, origin-form requests go there; when
  # unset, the proxy connects directly to whatever host each (absolute-form)
  # request names. Point your Azure provider baseURL at
  # http://127.0.0.1:8899/openai/v1 to route through it.

  ###
  # Start llm-proxy and wait for its port. The proxy routes its own logs
  # (LLM_PROXY_LOGFILE file, else syslog), so its stdio is dead weight — sever
  # it so the TUI never shares a terminal with the proxy. (Pre-init failures
  # still surface via the port wait below, not via the proxy's stderr.)
  llm-proxy </dev/null >/dev/null 2>&1 &
  _llm_proxy_pid=$!

  _llm_proxy_port="${LLM_PROXY_LISTEN_ADDR##*:}"
  for _i in $(seq 1 100); do
    if (echo >"/dev/tcp/127.0.0.1/${_llm_proxy_port}") 2>/dev/null; then
      break
    fi
    if ! kill -0 "${_llm_proxy_pid}" 2>/dev/null; then
      echo "ERROR: llm-proxy exited before listening on ${LLM_PROXY_LISTEN_ADDR}. Check syslog (tag llm-proxy)${LLM_PROXY_LOGFILE:+ or ${LLM_PROXY_LOGFILE}}." >&2
      exit 1
    fi
    sleep 0.1
  done
  if ! (echo >"/dev/tcp/127.0.0.1/${_llm_proxy_port}") 2>/dev/null; then
    echo "ERROR: llm-proxy did not listen on ${LLM_PROXY_LISTEN_ADDR} in time. Check syslog (tag llm-proxy)${LLM_PROXY_LOGFILE:+ or ${LLM_PROXY_LOGFILE}}." >&2
    exit 1
  fi
  unset _llm_proxy_pid _llm_proxy_port _i _llm_proxy_off
fi

GEMINI_CREDS_PATH="${GEMINI_OAUTH_CREDS_PATH:-$HOME/.gemini/oauth_creds.json}"
CONVERTER_PATH="${CONVERTER_PATH:-/usr/local/bin/convert-gemini.auth.ts}"

if [[ -f "${GEMINI_CREDS_PATH}" ]]; then
  bun "${CONVERTER_PATH}"
fi

exec /usr/local/bin/opencode "$@"
