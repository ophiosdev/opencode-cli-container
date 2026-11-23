// llm-proxy: localhost reverse/forward proxy that terminates app TLS over
// plain HTTP and opens a classical single-packet TLS 1.3 ClientHello upstream.
// HTTPS clients are served via CONNECT tunnels (opaque TCP relay).
//
// Why: Azure's front-end resets multi-segment ClientHello messages carrying
// the X25519MLKEM768 key share (sent by default by OpenSSL 3.5, Go 1.24+,
// Bun >= 1.4.1/BoringSSL, and rustls + aws-lc-rs). This proxy uses rustls
// with the *ring* provider (which has zero post-quantum groups) and puts
// SECP384R1 first, so the ClientHello stays small and even skips Azure's
// HelloRetryRequest. It optionally logs every LLM call + token usage as JSONL
// when LLM_LOG_FILE is set (no log file by default).

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderName, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{File, OpenOptions},
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

#[derive(Clone)]
enum TunnelVia {
    Direct,
    HttpProxy { addr: String, auth: Option<String> },
    Unsupported,
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    upstream: Option<String>,
    tunnel_via: TunnelVia,
    log_file: Option<Arc<Mutex<File>>>,
    log_bodies: bool,
}

#[derive(Deserialize, Default)]
struct ReqMeta {
    #[serde(default)]
    model: String,
    #[serde(default)]
    stream: bool,
}

#[derive(Deserialize, Default)]
struct UsageDetails {
    #[serde(default)]
    cached_tokens: u64,
}

#[derive(Deserialize, Default)]
struct UsageStats {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    prompt_tokens_details: Option<UsageDetails>,
    input_tokens_details: Option<UsageDetails>,
}

#[derive(Deserialize)]
struct ResponseInner {
    #[serde(default)]
    model: String,
    usage: Option<UsageStats>,
}

#[derive(Deserialize)]
struct UsageEnvelope {
    #[serde(default)]
    model: String,
    usage: Option<UsageStats>,
    response: Option<ResponseInner>,
}

#[derive(Serialize)]
struct CallRecord {
    ts_ms: u128,
    method: String,
    path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    model: String,
    stream: bool,
    status: u16,
    ttfb_ms: u64,
    duration_ms: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    total_tokens: u64,
    req_bytes: usize,
    resp_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_body: Option<String>,
}

fn is_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn apply_usage(rec: &mut CallRecord, model: &str, usage: Option<&UsageStats>) {
    if !model.is_empty() && rec.model.is_empty() {
        rec.model = model.to_string();
    }
    if let Some(u) = usage {
        if u.input_tokens > 0 {
            rec.input_tokens = u.input_tokens;
        } else if u.prompt_tokens > 0 {
            rec.input_tokens = u.prompt_tokens;
        }
        if u.output_tokens > 0 {
            rec.output_tokens = u.output_tokens;
        } else if u.completion_tokens > 0 {
            rec.output_tokens = u.completion_tokens;
        }
        if u.total_tokens > 0 {
            rec.total_tokens = u.total_tokens;
        }
        if let Some(d) = &u.input_tokens_details {
            if d.cached_tokens > 0 {
                rec.cached_tokens = d.cached_tokens;
            }
        } else if let Some(d) = &u.prompt_tokens_details {
            if d.cached_tokens > 0 {
                rec.cached_tokens = d.cached_tokens;
            }
        }
    }
}

fn extract_usage(raw: &[u8], is_sse: bool, rec: &mut CallRecord) {
    let parse_json = |slice: &[u8], rec: &mut CallRecord| {
        if !slice.windows(7).any(|w| w == br#""usage""#.as_slice()) {
            return;
        }
        if let Ok(env) = serde_json::from_slice::<UsageEnvelope>(slice) {
            apply_usage(rec, &env.model, env.usage.as_ref());
            if let Some(resp) = &env.response {
                apply_usage(rec, &resp.model, resp.usage.as_ref());
            }
        }
    };

    if !is_sse {
        parse_json(raw, rec);
        return;
    }

    let text = String::from_utf8_lossy(raw);
    for line in text.lines() {
        let line = line.trim();
        if let Some(payload) = line.strip_prefix("data:") {
            let payload = payload.trim();
            if !payload.is_empty() && payload != "[DONE]" {
                parse_json(payload.as_bytes(), rec);
            }
        }
    }
}

fn write_log(file: Option<&Mutex<File>>, rec: &CallRecord) {
    let Some(file) = file else { return };
    if let Ok(mut line) = serde_json::to_vec(rec) {
        line.push(b'\n');
        if let Ok(mut f) = file.lock() {
            let _ = f.write_all(&line);
        }
    }
}

fn redact_proxy_url(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(mut u) => {
            if u.password().is_some() {
                let _ = u.set_password(Some("xxxxx"));
            }
            u.to_string()
        }
        Err(_) => raw.to_string(),
    }
}

fn resolve_target(upstream: Option<&str>, uri: &Uri) -> Option<String> {
    let pq = uri.path_and_query().map(|x| x.as_str()).unwrap_or("/");
    // Forward-proxy style (absolute URI) reaches any host directly;
    // origin-form requests fall back to the configured upstream.
    // Either way the proxy originates upstream TLS with classical curves.
    match (uri.scheme_str(), uri.authority()) {
        (Some(scheme), Some(authority)) if scheme == "http" || scheme == "https" => {
            Some(format!("{scheme}://{authority}{pq}"))
        }
        _ => upstream.map(|base| format!("{base}{pq}")),
    }
}

fn parse_tunnel_via(raw: &str) -> TunnelVia {
    let v = raw.trim();
    if v.is_empty()
        || v.eq_ignore_ascii_case("none")
        || v.eq_ignore_ascii_case("direct")
        || v.eq_ignore_ascii_case("off")
    {
        return TunnelVia::Direct;
    }
    let normalized = if v.contains("://") {
        v.to_string()
    } else {
        format!("http://{v}")
    };
    match reqwest::Url::parse(&normalized) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => {
            let host = u.host_str().unwrap_or("").to_string();
            let port = u
                .port_or_known_default()
                .unwrap_or(if u.scheme() == "https" { 443 } else { 80 });
            let auth = match (u.username(), u.password()) {
                ("", _) => None,
                (user, pass) => Some(base64::engine::general_purpose::STANDARD.encode(format!(
                    "{}:{}",
                    user,
                    pass.unwrap_or("")
                ))),
            };
            TunnelVia::HttpProxy {
                addr: format!("{host}:{port}"),
                auth,
            }
        }
        _ => TunnelVia::Unsupported,
    }
}

async fn open_upstream(authority: &str, via: &TunnelVia) -> Result<TcpStream, String> {
    let connect = async {
        match via {
            TunnelVia::Direct => TcpStream::connect(authority)
                .await
                .map_err(|e| e.to_string()),
            TunnelVia::HttpProxy { addr, auth } => {
                let stream = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
                let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
                if let Some(a) = auth {
                    req.push_str(&format!("Proxy-Authorization: Basic {a}\r\n"));
                }
                req.push_str("\r\n");
                let mut reader = tokio::io::BufReader::new(stream);
                reader
                    .get_mut()
                    .write_all(req.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                let mut head = Vec::new();
                loop {
                    let mut line = Vec::new();
                    let n = reader.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        return Err("corporate proxy closed the connection".to_string());
                    }
                    head.extend_from_slice(&line);
                    if head.len() > 32768 {
                        return Err("corporate proxy header too large".to_string());
                    }
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let ok = String::from_utf8_lossy(&head)
                    .lines()
                    .next()
                    .is_some_and(|l| l.contains(" 200"));
                if !ok {
                    return Err(format!(
                        "corporate proxy refused: {}",
                        String::from_utf8_lossy(&head).lines().next().unwrap_or("")
                    ));
                }
                Ok(reader.into_inner())
            }
            TunnelVia::Unsupported => {
                Err("SOCKS upstream chaining is not supported for CONNECT tunnels".to_string())
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(15), connect)
        .await
        .map_err(|_| "upstream connect timed out".to_string())?
}

async fn connect_tunnel(req: Request<Body>, state: AppState) -> Response {
    let authority = match req.uri().authority().map(|a| a.to_string()) {
        Some(a) => a,
        None => return (StatusCode::BAD_REQUEST, "CONNECT requires an authority").into_response(),
    };
    let on_upgrade = hyper::upgrade::on(req);
    let via = state.tunnel_via.clone();
    let upstream = match open_upstream(&authority, &via).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("CONNECT {authority} failed: {e}"),
            )
                .into_response()
        }
    };
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let mut client = hyper_util::rt::TokioIo::new(upgraded);
                let mut server = upstream;
                if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut server).await {
                    eprintln!("llm-proxy: CONNECT {authority} relay error: {e}");
                }
            }
            Err(e) => eprintln!("llm-proxy: CONNECT {authority} upgrade failed: {e}"),
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

async fn proxy_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    req: Request<Body>,
) -> Response {
    // HTTPS clients reach a forward proxy via CONNECT (opaque tunnel).
    // PQC-sensitive hosts (Azure) must use the plain-HTTP paths above so the
    // proxy originates TLS with classical curves instead.
    if method == Method::CONNECT {
        return connect_tunnel(req, state).await;
    }

    let start = Instant::now();
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let req_bytes = match to_bytes(req.into_body(), 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };

    let meta: ReqMeta = serde_json::from_slice(&req_bytes).unwrap_or_default();
    let mut rec = CallRecord {
        ts_ms,
        method: method.to_string(),
        path: uri.path().to_string(),
        model: meta.model,
        stream: meta.stream,
        status: 0,
        ttfb_ms: 0,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        req_bytes: req_bytes.len(),
        resp_bytes: 0,
        request_body: if state.log_bodies && !req_bytes.is_empty() {
            Some(String::from_utf8_lossy(&req_bytes).into_owned())
        } else {
            None
        },
    };

    let mut fwd_headers = HeaderMap::new();
    for (k, v) in &headers {
        // Strip hop-by-hop + accept-encoding so Azure returns plain JSON/SSE for token parsing
        if !is_hop_header(k) && k.as_str() != "accept-encoding" {
            fwd_headers.append(k.clone(), v.clone());
        }
    }

    let target = match resolve_target(state.upstream.as_deref(), &uri) {
        Some(t) => t,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "llm-proxy: origin-form request without UPSTREAM_URL; send an absolute URI or set UPSTREAM_URL",
            )
                .into_response();
        }
    };

    let upstream_resp = match state
        .client
        .request(method, target.as_str())
        .headers(fwd_headers)
        .body(req_bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            rec.status = StatusCode::BAD_GATEWAY.as_u16();
            rec.duration_ms = start.elapsed().as_millis() as u64;
            write_log(state.log_file.as_deref(), &rec);
            return (StatusCode::BAD_GATEWAY, e.to_string()).into_response();
        }
    };

    rec.status = upstream_resp.status().as_u16();
    rec.ttfb_ms = start.elapsed().as_millis() as u64;

    let is_sse = upstream_resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("text/event-stream"));

    let mut resp_builder = Response::builder().status(upstream_resp.status());
    if let Some(h) = resp_builder.headers_mut() {
        for (k, v) in upstream_resp.headers() {
            if !is_hop_header(k) {
                h.append(k.clone(), v.clone());
            }
        }
    }

    let (tx, rx) = mpsc::channel::<Result<Bytes, reqwest::Error>>(32);
    let log_file = state.log_file.clone();

    tokio::spawn(async move {
        let mut stream = upstream_resp.bytes_stream();
        let mut captured = Vec::new();
        while let Some(chunk) = stream.next().await {
            if let Ok(ref b) = chunk {
                captured.extend_from_slice(b);
            }
            if tx.send(chunk).await.is_err() {
                break;
            }
        }
        rec.duration_ms = start.elapsed().as_millis() as u64;
        rec.resp_bytes = captured.len();
        extract_usage(&captured, is_sse, &mut rec);
        write_log(log_file.as_deref(), &rec);
    });

    resp_builder
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

#[tokio::main]
async fn main() {
    // Use rustls + ring (no X25519MLKEM768) and put P-384 first to skip Azure's HRR
    let mut provider = rustls::crypto::ring::default_provider();
    provider.kx_groups = vec![
        rustls::crypto::ring::kx_group::SECP384R1,
        rustls::crypto::ring::kx_group::X25519,
        rustls::crypto::ring::kx_group::SECP256R1,
    ];
    provider
        .install_default()
        .expect("install rustls ring provider");

    // No UPSTREAM_URL: connect directly to whatever host each request names
    // (absolute-form URIs). Origin-form requests then need UPSTREAM_URL.
    let upstream: Option<String> = env::var("UPSTREAM_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string());
    let listen_addr = env::var("LISTEN_ADDR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:8899".into());
    let log_path = env::var("LLM_LOG_FILE")
        .ok()
        .filter(|s| !s.trim().is_empty());

    let log_file = match &log_path {
        Some(path) => Some(Arc::new(Mutex::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("open LLM_LOG_FILE"),
        ))),
        None => None,
    };
    let log_bodies = env::var("LLM_LOG_BODIES").is_ok_and(|v| v == "1");

    let mut client_builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());

    let upstream_proxy = env::var("UPSTREAM_PROXY").unwrap_or_default();
    // Note: an unset UPSTREAM_PROXY means direct, NOT env fallback. The
    // container-wide HTTP(S)_PROXY points at this proxy itself, so falling
    // back to env proxies here would relay upstream traffic into ourselves.
    let proxy_desc = match upstream_proxy.trim().to_ascii_lowercase().as_str() {
        "" => {
            client_builder = client_builder.no_proxy();
            "direct".to_string()
        }
        "none" | "direct" | "off" => {
            client_builder = client_builder.no_proxy();
            "direct (disabled)".to_string()
        }
        _ => {
            let trimmed = upstream_proxy.trim();
            let normalized = if trimmed.contains("://") {
                trimmed.to_string()
            } else {
                format!("http://{trimmed}")
            };
            let proxy = reqwest::Proxy::all(normalized.as_str()).expect("invalid UPSTREAM_PROXY");
            client_builder = client_builder.proxy(proxy);
            redact_proxy_url(&normalized)
        }
    };

    let client = client_builder.build().expect("build reqwest client");

    let state = AppState {
        client,
        upstream: upstream.clone(),
        tunnel_via: parse_tunnel_via(&env::var("UPSTREAM_PROXY").unwrap_or_default()),
        log_file,
        log_bodies,
    };

    let app = Router::new().fallback(proxy_handler).with_state(state);
    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .expect("bind listen address");

    eprintln!(
        "llm-proxy (rust) listening on http://{listen_addr} -> {route} (upstream proxy: {proxy_desc}, logs: {log_display})",
        route = upstream.as_deref().unwrap_or("direct"),
        log_display = log_path.as_deref().unwrap_or("disabled")
    );
    axum::serve(listener, app).await.expect("serve");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_absolute_uris_to_their_own_host() {
        let uri: Uri = "https://other.example.com/openai/v1/models".parse().unwrap();
        assert_eq!(
            resolve_target(Some("https://default.example.com"), &uri),
            Some("https://other.example.com/openai/v1/models".to_string())
        );
        // ... even with no UPSTREAM_URL configured (direct mode).
        assert_eq!(
            resolve_target(None, &uri),
            Some("https://other.example.com/openai/v1/models".to_string())
        );
    }

    #[test]
    fn falls_back_to_upstream_for_origin_form() {
        let uri: Uri = "/openai/v1/chat/completions?api-version=xyz".parse().unwrap();
        assert_eq!(
            resolve_target(Some("https://default.example.com"), &uri),
            Some("https://default.example.com/openai/v1/chat/completions?api-version=xyz".to_string())
        );
    }

    #[test]
    fn rejects_origin_form_without_upstream() {
        let uri: Uri = "/openai/v1/chat/completions".parse().unwrap();
        assert_eq!(resolve_target(None, &uri), None);
    }

    #[test]
    fn parses_tunnel_upstream() {
        assert!(matches!(parse_tunnel_via(""), TunnelVia::Direct));
        assert!(matches!(parse_tunnel_via("direct"), TunnelVia::Direct));
        match parse_tunnel_via("http://user:pass@corp:3128") {
            TunnelVia::HttpProxy { addr, auth } => {
                assert_eq!(addr, "corp:3128");
                assert!(auth.is_some());
            }
            other => panic!("expected HttpProxy, got {:?}", std::mem::discriminant(&other)),
        }
        assert!(matches!(
            parse_tunnel_via("socks5h://127.0.0.1:1080"),
            TunnelVia::Unsupported
        ));
    }
}
