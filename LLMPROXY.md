# LLM Proxy

This document describes use of the `llm-proxy` HTTP proxy that ships inside the OpenCode CLI image.

## Purpose

OpenCode runs inside a container where all outgoing HTTP(S) traffic goes through a localhost proxy at `http://127.0.0.1:8899`. The proxy starts itself, without user action, on container launch.

The proxy ensures TLS connections to upstream services — in particular Azure Foundry — are established using classical curves, so the upstream front-end never receives post-quantum client hellos it would reject. It also terminates intercepted TLS connections locally, endpoints that are reached via plain HTTP are forwarded, and everything else is relayed. In short, HTTPS traffic visible to the proxy never inherits the client’s TLS capabilities.

For the user, this behavior is transparent and no manual proxy configuration is required.

## Configuration

All configuration is done with environment variables. Below, in alphabetical order.

> [!WARNING]
> `HTTP_PROXY` / `HTTPS_PROXY` (and lowercase) are enforced by the entrypoint; any other value is overridden with a warning.
> `NO_PROXY` / `no_proxy` are equally enforced to `localhost,127.0.0.1`. Existing value is overridden with a warning.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROXY_ENABLED` | enabled | `off`, `0`, `false` or `no` disables the proxy entirely: it is not started and no proxy environment is enforced. |
| `LLM_PROXY_LISTEN_ADDR` | `127.0.0.1:8899` | Address the proxy listens on; also the value `HTTP_PROXY` is forced to. |
| `LLM_PROXY_INTERCEPT_SUFFIXES` | everything | Comma-separated domain suffixes (e.g. `cognitiveservices.azure.com`) whose TLS is terminated locally. Empty means all hosts. |
| `LLM_PROXY_MITM` | enabled | `off` disables TLS termination; all `CONNECT` tunnels are then relayed opaquely. |
| `LLM_PROXY_MITM_CA_CERT` / `LLM_PROXY_MITM_CA_KEY` | baked-in image paths | Optional alternate CA certificate/key files for terminated TLS. |
| `LLM_PROXY_UPSTREAM_PROXY` | direct | Optional corporate proxy for the proxy's own upstream connections: an `http://` or `https://` URL, or `direct`/`none`/`off` to force direct connections. Unset means direct (container-wide `HTTP_PROXY` is never followed by the proxy itself). |
| `LLM_PROXY_UPSTREAM_URL` | none | Upstream origin for reverse-proxying (e.g. `https://example.com`). When set, relative (origin-form) requests are forwarded there. When unset, each request must name its target host or it is rejected. |
| `LLM_PROXY_TLS_MIN_VERSION` / `LLM_PROXY_TLS_MAX_VERSION` | none | Bound TLS versions accepted by the proxy. Values `1.2` or `1.3` only; any other value, or minimum above maximum, prevents startup with an error. |
| `LLM_PROXY_LOGFILE` | syslog | Path of the proxy's own log file. Parent directories are created automatically. Unset means syslog (requires something listening on `/dev/log`, otherwise stderr fallback). |
| `LLM_PROXY_LOGLEVEL` | `INFO` | Maximum log verbosity: `ERROR`, `WARN`, `INFO` (default), or `DEBUG`. Any other value prevents startup with an error. Relay ends and byte counts appear only at `DEBUG`. |
| `LLM_PROXY_LLM_LOGFILE` | none | Optional JSONL log of every forwarded LLM request (status, latency, token counts). Unset disables it. |
| `LLM_PROXY_LLM_LOG_BODIES` | off | `1` also stores complete request bodies in the JSONL log. |

Two operational aspects worth knowing:

- Every `CONNECT` accepted by the proxy produces exactly one `INFO` line in the proxy log (`CONNECT <authority> (MITM|tunnel) <host>`). Relay end details are `DEBUG` only.
- If no log file is configured, the proxy logs via syslog (facility `daemon`, tag `llm-proxy`). With no syslog listener the messages fall back to stderr; the container's entrypoint severs the proxy's stdio so they cannot corrupt the OpenCode TUI.
