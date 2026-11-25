// llm-proxy: localhost reverse/forward/MITM proxy. Plain HTTP is forwarded
// (absolute URI) or reverse-proxied (LLM_PROXY_UPSTREAM_URL) with a classical
// single-packet TLS 1.3 ClientHello upstream; CONNECT tunnels listed
// LLM_PROXY_INTERCEPT_SUFFIXES hosts with full TLS termination so the proxy — not the
// client — controls the upstream ciphers.
// HTTPS clients are served via CONNECT tunnels (opaque TCP relay).
//
// Why: Azure's front-end resets multi-segment ClientHello messages carrying
// the X25519MLKEM768 key share (sent by default by OpenSSL 3.5, Go 1.24+,
// Bun >= 1.4.1/BoringSSL, and rustls + aws-lc-rs). This proxy uses rustls
// with the *ring* provider (which has zero post-quantum groups) and puts
// SECP384R1 first, so the ClientHello stays small and even skips Azure's
// HelloRetryRequest. It optionally logs every LLM call + token usage as JSONL
// when LLM_PROXY_LLM_LOGFILE is set (no log file by default).

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderName, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use base64::Engine as _;
use rcgen::{
    CertificateParams, DnType, ExtendedKeyUsagePurpose, Issuer, KeyPair, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::version::{TLS12, TLS13};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, ServerConfig, SignatureScheme, SupportedProtocolVersion};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs::{File, OpenOptions},
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

/// Where the proxy's own logs go: LLM_PROXY_LOGFILE file, syslog, or stderr.
enum LogSink {
    File(Mutex<File>),
    Syslog(Mutex<syslog::Logger<syslog::LoggerBackend, syslog::Formatter3164>>),
    Stderr,
}

static LOGGER: OnceLock<LogSink> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

fn parse_log_level(raw: &str) -> Result<Level, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => Ok(Level::Info),
        "error" => Ok(Level::Error),
        "warn" | "warning" => Ok(Level::Warn),
        "info" => Ok(Level::Info),
        "debug" => Ok(Level::Debug),
        _ => Err(format!(
            "llm-proxy: LLM_PROXY_LOGLEVEL must be one of ERROR, WARN, INFO, DEBUG; got {raw:?}"
        )),
    }
}

fn max_level() -> Level {
    *MAX_LEVEL.get().unwrap_or(&Level::Info)
}

static MAX_LEVEL: OnceLock<Level> = OnceLock::new();

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug => "DEBUG",
    }
}

fn log_msg(level: Level, msg: &str) {
    if level > max_level() {
        return;
    }
    match LOGGER.get().unwrap_or(&LogSink::Stderr) {
        LogSink::File(f) => {
            if let Ok(mut f) = f.lock() {
                let _ = writeln!(f, "[{}] {msg}", level_name(level));
            }
        }
        LogSink::Syslog(l) => {
            if let Ok(mut l) = l.lock() {
                match level {
                    Level::Error => {
                        let _ = l.err(msg);
                    }
                    Level::Warn => {
                        let _ = l.warning(msg);
                    }
                    Level::Info => {
                        let _ = l.info(msg);
                    }
                    Level::Debug => {
                        let _ = l.debug(msg);
                    }
                }
            }
        }
        LogSink::Stderr => eprintln!("[{}] {msg}", level_name(level)),
    }
}

macro_rules! log_line {
    ($lvl:expr, $($arg:tt)*) => {
        $crate::log_msg($lvl, &format!($($arg)*))
    };
}

/// Own the proxy's log routing: LLM_PROXY_LOGFILE file if set (creating parent
/// dirs), else syslog, else stderr if syslog is unreachable.
/// LLM_PROXY_LOGLEVEL caps verbosity (ERROR/WARN/INFO/DEBUG, default INFO).
fn init_logging() {
    let max = match parse_log_level(&env::var("LLM_PROXY_LOGLEVEL").unwrap_or_default()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let _ = MAX_LEVEL.set(max);
    if let Some(path) = env::var("LLM_PROXY_LOGFILE").ok().filter(|s| !s.trim().is_empty()) {
        if let Some(parent) = Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => {
                let _ = LOGGER.set(LogSink::File(Mutex::new(f)));
                return;
            }
            Err(e) => eprintln!("llm-proxy: cannot open LLM_PROXY_LOGFILE {path}: {e}; trying syslog"),
        }
    }
    let formatter = syslog::Formatter3164 {
        facility: syslog::Facility::LOG_DAEMON,
        hostname: None,
        process: "llm-proxy".to_string(),
        pid: std::process::id(),
    };
    match syslog::unix(formatter) {
        Ok(logger) => {
            let _ = LOGGER.set(LogSink::Syslog(Mutex::new(logger)));
        }
        Err(e) => {
            let _ = LOGGER.set(LogSink::Stderr);
            eprintln!("llm-proxy: syslog unavailable ({e}); logging to stderr");
        }
    }
}

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
    mitm: Option<Arc<MitmState>>,
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

/// Baked-in image paths (created once per image build, see Dockerfile).
/// Override with LLM_PROXY_MITM_CA_CERT / LLM_PROXY_MITM_CA_KEY to mount a pre-provisioned CA.
const DEFAULT_LLM_PROXY_MITM_CA_CERT: &str = "/usr/local/share/ca-certificates/llm-proxy-mitm.crt";
const DEFAULT_LLM_PROXY_MITM_CA_KEY: &str = "/usr/local/share/llm-proxy/mitm-ca-key.pem";

fn ca_paths() -> (PathBuf, PathBuf) {
    let cert = env::var("LLM_PROXY_MITM_CA_CERT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LLM_PROXY_MITM_CA_CERT));
    let key = env::var("LLM_PROXY_MITM_CA_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LLM_PROXY_MITM_CA_KEY));
    (cert, key)
}

struct CaAuthority {
    issuer: Arc<Issuer<'static, KeyPair>>,
}

/// Load a separately-provisioned CA (see entrypoint: `openssl req -x509`).
/// The PEM is intentionally leaked: the issuer borrows it for the proxy's
/// whole lifetime, so a one-time leak is the simplest sound ownership.
fn load_ca_authority(cert_path: &Path, key_path: &Path) -> Result<CaAuthority, String> {
    let key_pem = std::fs::read_to_string(key_path).map_err(|e| {
        format!(
            "MITM CA key not found at {}: {e} (baked into the image; override with LLM_PROXY_MITM_CA_KEY)",
            key_path.display()
        )
    })?;
    let cert_pem = std::fs::read_to_string(cert_path).map_err(|e| {
        format!(
            "MITM CA cert not found at {}: {e} (baked into the image; override with LLM_PROXY_MITM_CA_CERT)",
            cert_path.display()
        )
    })?;
    let key = KeyPair::from_pem(&key_pem).map_err(|e| e.to_string())?;
    let leaked: &'static str = Box::leak(cert_pem.into_boxed_str());
    let issuer = Issuer::from_ca_cert_pem(leaked, key).map_err(|e| e.to_string())?;
    Ok(CaAuthority {
        issuer: Arc::new(issuer),
    })
}

fn issue_leaf(issuer: &Issuer<'static, KeyPair>, host: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut params = if let Ok(ip) = host.parse::<IpAddr>() {
        let mut p = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
        p.subject_alt_names = vec![SanType::IpAddress(ip)];
        p.distinguished_name.push(DnType::CommonName, host);
        p
    } else {
        CertificateParams::new(vec![host.to_string()]).map_err(|e| e.to_string())?
    };
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before =
        time::OffsetDateTime::now_utc() - time::Duration::days(1);
    params.not_after =
        time::OffsetDateTime::now_utc() + time::Duration::days(365);
    let key = KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.signed_by(&key, issuer).map_err(|e| e.to_string())?;
    Ok((cert.der().to_vec(), key.serialize_der()))
}

fn parse_suffixes(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn intercept_host(host: &str, suffixes: &[String]) -> bool {
    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return false;
    }
    // No configured suffixes: intercept everything.
    if suffixes.is_empty() {
        return true;
    }
    suffixes.iter().any(|s| s == "*" || host == *s || host.ends_with(&format!(".{s}")))
}

/// Host part of a CONNECT authority (`example.com:443` -> `example.com`).
fn authority_host(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split("]:").next().unwrap_or(rest.trim_end_matches(']'));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    }
}

fn config_for_host(mitm: &MitmState, host: &str) -> Result<Arc<ServerConfig>, String> {
    if let Some(cfg) = mitm.cache.lock().map_err(|e| e.to_string())?.get(host) {
        return Ok(cfg.clone());
    }
    let (cert_der, key_der) = issue_leaf(&mitm.issuer, host)?;
    let cfg = ServerConfig::builder_with_protocol_versions(&mitm.versions)
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert_der)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
        )
        .map_err(|e| e.to_string())?;
    let cfg = Arc::new(cfg);
    mitm.cache
        .lock()
        .map_err(|e| e.to_string())?
        .insert(host.to_string(), cfg.clone());
    Ok(cfg)
}

struct MitmState {
    issuer: Arc<Issuer<'static, KeyPair>>,
    suffixes: Vec<String>,
    versions: Vec<&'static SupportedProtocolVersion>,
    cache: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

/// Insecure opt-out selected with LLM_PROXY_DISABLE_CERT_VERIFICATION=1:
/// upstream TLS certificates are accepted without chain validation.
#[derive(Debug)]
struct NoCertVerifier;

impl ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let provider = rustls::crypto::ring::default_provider();
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let provider = rustls::crypto::ring::default_provider();
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn cert_verification_disabled_raw(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// True when LLM_PROXY_DISABLE_CERT_VERIFICATION opts out of upstream
/// TLS certificate-chain validation. Default (unset/anything else): verify.
fn upstream_cert_verification_disabled() -> bool {
    env::var("LLM_PROXY_DISABLE_CERT_VERIFICATION")
        .is_ok_and(|v| cert_verification_disabled_raw(&v))
}

fn init_mitm(versions: Vec<&'static SupportedProtocolVersion>) -> Option<Arc<MitmState>> {
    if env::var("LLM_PROXY_MITM").is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
        return None;
    }
    // No LLM_PROXY_INTERCEPT_SUFFIXES: intercept everything.
    let suffixes = match env::var("LLM_PROXY_INTERCEPT_SUFFIXES") {
        Ok(raw) => parse_suffixes(&raw),
        Err(_) => Vec::new(),
    };
    let (cert_path, key_path) = ca_paths();
    match load_ca_authority(&cert_path, &key_path) {
        Ok(ca) => {
            log_line!(
                Level::Info,
                "llm-proxy: MITM enabled for [{}] (CA: {})",
                suffixes.join(", "),
                cert_path.display()
            );
            Some(Arc::new(MitmState {
                issuer: ca.issuer,
                suffixes,
                versions,
                cache: Mutex::new(HashMap::new()),
            }))
        }
        Err(e) => {
            log_line!(Level::Warn, "llm-proxy: MITM disabled, {e}");
            None
        }
    }
}

fn parse_tls_version(raw: &str, var: &str) -> Result<Option<u8>, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(None);
    }
    match v {
        "1.2" => Ok(Some(2)),
        "1.3" => Ok(Some(3)),
        _ => Err(format!(
            "llm-proxy: {var} must be \"1.2\" or \"1.3\", got {raw:?}"
        )),
    }
}

/// Effective TLS versions from LLM_PROXY_MIN/MAX_TLS_VERSION.
/// Unset bounds mean "no restriction"; min > max is a startup error.
fn tls_versions(min: Option<u8>, max: Option<u8>) -> Result<Vec<&'static SupportedProtocolVersion>, String> {
    if let (Some(lo), Some(hi)) = (min, max) {
        if lo > hi {
            return Err(format!(
                "llm-proxy: LLM_PROXY_TLS_MIN_VERSION (1.{lo}) is higher than LLM_PROXY_TLS_MAX_VERSION (1.{hi})"
            ));
        }
    }
    let mut out = Vec::with_capacity(2);
    if max.unwrap_or(3) >= 3 && min.unwrap_or(2) <= 3 {
        out.push(&TLS13);
    }
    if max.unwrap_or(3) >= 2 && min.unwrap_or(2) <= 2 {
        out.push(&TLS12);
    }
    Ok(out)
}

fn tls_bounds_or_exit() -> (
    Option<u8>,
    Option<u8>,
    Vec<&'static SupportedProtocolVersion>,
) {
    let min = match parse_tls_version(
        &env::var("LLM_PROXY_TLS_MIN_VERSION").unwrap_or_default(),
        "LLM_PROXY_TLS_MIN_VERSION",
    ) {
        Ok(v) => v,
        Err(e) => {
            log_line!(Level::Error, "{e}");
            std::process::exit(1);
        }
    };
    let max = match parse_tls_version(
        &env::var("LLM_PROXY_TLS_MAX_VERSION").unwrap_or_default(),
        "LLM_PROXY_TLS_MAX_VERSION",
    ) {
        Ok(v) => v,
        Err(e) => {
            log_line!(Level::Error, "{e}");
            std::process::exit(1);
        }
    };
    match tls_versions(min, max) {
        Ok(versions) => (min, max, versions),
        Err(e) => {
            log_line!(Level::Error, "{e}");
            std::process::exit(1);
        }
    }
}

fn reqwest_tls_version(v: u8) -> reqwest::tls::Version {
    if v >= 3 {
        reqwest::tls::Version::TLS_1_3
    } else {
        reqwest::tls::Version::TLS_1_2
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

/// Explicit port of a CONNECT authority, if any.
fn connect_port(authority: &str) -> Option<u16> {    if let Some(rest) = authority.strip_prefix('[') {
        return rest.rsplit_once("]:").and_then(|(_, p)| p.parse().ok());
    }
    match authority.rsplit_once(':') {
        Some((_, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => p.parse().ok(),
        _ => None,
    }
}

/// Bounded `tls.handshake.failed.<reason>` key for a peer rustls error
/// (taxonomy stolen from sozu-proxy, ideas only). Unknown variants collapse
/// to `.other` so grep/metric cardinality stays predictable.
fn handshake_failure_reason(err: &rustls::Error) -> &'static str {
    match err {
        rustls::Error::AlertReceived(_) => "tls.handshake.failed.alert_received",
        rustls::Error::PeerIncompatible(_) => "tls.handshake.failed.peer_incompatible",
        rustls::Error::PeerMisbehaved(_) => "tls.handshake.failed.peer_misbehaved",
        rustls::Error::InvalidMessage(_) => "tls.handshake.failed.invalid_message",
        rustls::Error::InappropriateMessage { .. } => "tls.handshake.failed.inappropriate_message",
        rustls::Error::InappropriateHandshakeMessage { .. } => {
            "tls.handshake.failed.inappropriate_handshake_message"
        }
        rustls::Error::PeerSentOversizedRecord => "tls.handshake.failed.oversized_record",
        rustls::Error::NoApplicationProtocol => "tls.handshake.failed.no_alpn",
        rustls::Error::InvalidCertificate(_) => "tls.handshake.failed.invalid_certificate",
        rustls::Error::DecryptError => "tls.handshake.failed.decrypt_error",
        rustls::Error::NoCertificatesPresented => "tls.handshake.failed.no_certificates_present",
        _ => "tls.handshake.failed.other",
    }
}

/// Tier for a TLS handshake failure (sozu taxonomy, SMITH-free):
/// - `alert_received`: peer rejected our cert/config — routine, `Debug`.
/// - protocol violations incl. ALPN mismatch: buggy/stale peers — `Warn`.
/// - everything else (local/config): genuine — `Error`.
/// - peer disconnect mid-handshake (reset/abort/pipe/eof): routine — `Debug`.
fn handshake_error_tier(err: &std::io::Error) -> (Level, &'static str) {
    if let Some(rustls_err) = err.get_ref().and_then(|s| s.downcast_ref::<rustls::Error>()) {
        return match rustls_err {
            rustls::Error::AlertReceived(_) => (Level::Debug, handshake_failure_reason(rustls_err)),
            rustls::Error::PeerIncompatible(_)
            | rustls::Error::PeerMisbehaved(_)
            | rustls::Error::InvalidMessage(_)
            | rustls::Error::InappropriateMessage { .. }
            | rustls::Error::InappropriateHandshakeMessage { .. }
            | rustls::Error::PeerSentOversizedRecord
            | rustls::Error::NoApplicationProtocol
            | rustls::Error::InvalidCertificate(_)
            | rustls::Error::DecryptError
            | rustls::Error::NoCertificatesPresented => (Level::Warn, handshake_failure_reason(rustls_err)),
            _ => (Level::Error, handshake_failure_reason(rustls_err)),
        };
    }
    use std::io::ErrorKind;
    if matches!(
        err.kind(),
        ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::BrokenPipe
            | ErrorKind::UnexpectedEof
    ) {
        return (Level::Debug, "tls.handshake.failed.peer_closed");
    }
    (Level::Error, "tls.handshake.failed.other")
}

fn log_handshake_error(stage: &str, host: &str, err: &std::io::Error) -> &'static str {
    let (level, reason) = handshake_error_tier(err);
    log_line!(
        level,
        "llm-proxy: {stage} for {host} failed ({reason}): {err}"
    );
    reason
}

async fn mitm_handshake<IO>(
    client_io: IO,
    upstream_tcp: TcpStream,
    server_cfg: Arc<ServerConfig>,
    mut cc: ClientConfig,
    server_name: ServerName<'static>,
    host: &str,
) -> Result<
    (
        tokio_rustls::server::TlsStream<IO>,
        tokio_rustls::client::TlsStream<TcpStream>,
    ),
    String,
>
where
    IO: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let hello = match tokio_rustls::LazyConfigAcceptor::new(
        rustls::server::Acceptor::default(),
        client_io,
    )
    .await
    {
        Ok(hello) => hello,
        Err(e) => {
            let reason = log_handshake_error("client TLS ClientHello", host, &e);
            return Err(format!("client TLS ClientHello failed ({reason}): {e}"));
        }
    };
    cc.alpn_protocols = hello
        .client_hello()
        .alpn()
        .map(|protocols| protocols.map(|p| p.to_vec()).collect())
        .unwrap_or_default();
    let upstream_tls = match tokio_rustls::TlsConnector::from(Arc::new(cc))
        .connect(server_name, upstream_tcp)
        .await
    {
        Ok(tls) => tls,
        Err(e) => {
            let reason = log_handshake_error("upstream TLS handshake", host, &e);
            return Err(format!("upstream TLS handshake failed ({reason}): {e}"));
        }
    };
    // Byte relaying requires both TLS peers to select the same application protocol.
    let mut cfg = (*server_cfg).clone();
    cfg.alpn_protocols = upstream_tls
        .get_ref()
        .1
        .alpn_protocol()
        .map(|p| vec![p.to_vec()])
        .unwrap_or_default();
    let client_tls = match hello.into_stream(Arc::new(cfg)).await {
        Ok(tls) => tls,
        Err(e) => {
            let reason = log_handshake_error("client TLS handshake", host, &e);
            return Err(format!("client TLS handshake failed ({reason}): {e}"));
        }
    };
    if client_tls.get_ref().1.alpn_protocol() != upstream_tls.get_ref().1.alpn_protocol() {
        log_line!(
            Level::Warn,
            "llm-proxy: MITM setup for {host} failed (tls.handshake.failed.no_alpn): client and upstream ALPN protocols differ"
        );
        return Err("client and upstream ALPN protocols differ".to_string());
    }
    Ok((client_tls, upstream_tls))
}

async fn mitm_relay(
    host: String,
    upstream_addr: String,
    on_upgrade: hyper::upgrade::OnUpgrade,
    state: &AppState,
) -> Response {
    let mitm = match state.mitm.as_ref() {
        Some(m) => m.clone(),
        None => {
            return (StatusCode::BAD_GATEWAY, "llm-proxy: MITM is disabled")
                .into_response()
        }
    };
    let server_cfg = match config_for_host(&mitm, &host) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("llm-proxy: cannot issue certificate for {host}: {e}"),
            )
                .into_response()
        }
    };
    // Fail fast: dial upstream TCP before answering 200 to the client.
    let upstream_tcp = match open_upstream(&upstream_addr, &state.tunnel_via).await {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("llm-proxy: CONNECT {upstream_addr} failed: {e}"),
            )
                .into_response()
        }
    };
    tokio::spawn(async move {
        let setup = async {
            if upstream_cert_verification_disabled() {
                log_line!(
                    Level::Debug,
                    "llm-proxy: MITM upstream for {host}: skipping certificate-chain verification (NoCertVerifier)"
                );
            }
            let cc = if upstream_cert_verification_disabled() {
                ClientConfig::builder_with_protocol_versions(&mitm.versions)
                    .dangerous()
                    .with_custom_certificate_verifier(Arc::new(NoCertVerifier))
                    .with_no_client_auth()
            } else {
                let mut roots = RootCertStore::empty();
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
                ClientConfig::builder_with_protocol_versions(&mitm.versions)
                    .with_root_certificates(roots)
                    .with_no_client_auth()
            };
            let server_name: ServerName<'static> = match ServerName::try_from(host.clone()) {
                Ok(n) => n,
                Err(_) => match host.parse::<IpAddr>() {
                    Ok(ip) => ServerName::IpAddress(ip.into()),
                    Err(_) => return Err(format!("invalid upstream name: {host}")),
                },
            };
            let client_io = hyper_util::rt::TokioIo::new(
                on_upgrade.await.map_err(|e| format!("client upgrade failed: {e}"))?,
            );
            mitm_handshake(client_io, upstream_tcp, server_cfg, cc, server_name, &host).await
        };
        match tokio::time::timeout(Duration::from_secs(20), setup).await {
            Ok(Ok((mut a, mut b))) => {
                // Relay end, routine or not, is DEBUG-only in the global log.
                match tokio::io::copy_bidirectional(&mut a, &mut b).await {
                    Ok((up, down)) => log_line!(
                        Level::Debug,
                        "llm-proxy: MITM relay for {host} ended: {up} bytes up, {down} bytes down"
                    ),
                    Err(e) => log_line!(Level::Debug, "llm-proxy: MITM relay for {host} ended: {e}"),
                }
            }
            // Handshake failures were already logged inside `mitm_handshake`
            // with their tier + bounded reason; don't double-log.
            Ok(Err(_)) => {}
            Err(_) => log_line!(Level::Warn, "llm-proxy: MITM setup for {host} timed out"),
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

async fn connect_tunnel(req: Request<Body>, state: AppState) -> Response {
    let authority = match req.uri().authority().map(|a| a.to_string()) {
        Some(a) => a,
        None => return (StatusCode::BAD_REQUEST, "CONNECT requires an authority").into_response(),
    };
    let on_upgrade = hyper::upgrade::on(req);
    let host = authority_host(&authority).to_lowercase();
    // MITM: terminate TLS here so the proxy — not the client — controls the
    // upstream ClientHello (classical curves only). Only for TLS ports and
    // configured suffixes; everything else stays a transparent tunnel.
    if let Some(mitm) = state.mitm.clone() {
        let tls_port = connect_port(&authority).is_none_or(|p| p == 443);
        if tls_port && intercept_host(&host, &mitm.suffixes) {
            let upstream_addr = if authority.contains(':') {
                authority.clone()
            } else {
                format!("{authority}:443")
            };
            log_line!(Level::Info, "llm-proxy: CONNECT {authority} (MITM {host}){verify_note}", verify_note = if upstream_cert_verification_disabled() { " cert-verify=off" } else { "" });
            return mitm_relay(host, upstream_addr, on_upgrade, &state).await;
        }
    }
    let via = state.tunnel_via.clone();
    let upstream = match open_upstream(&authority, &via).await {
        Ok(s) => s,
        Err(e) => {
            log_line!(Level::Warn, "llm-proxy: CONNECT {authority} failed: {e}");
            return (
                StatusCode::BAD_GATEWAY,
                format!("CONNECT {authority} failed: {e}"),
            )
                .into_response()
        }
    };
    log_line!(Level::Info, "llm-proxy: CONNECT {authority} (tunnel {host})");
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let mut client = hyper_util::rt::TokioIo::new(upgraded);
                let mut server = upstream;
                // Relay end, routine or not, is DEBUG-only in the global log.
                match tokio::io::copy_bidirectional(&mut client, &mut server).await {
                    Ok((up, down)) => log_line!(
                        Level::Debug,
                        "llm-proxy: CONNECT relay for {host} ended: {up} bytes up, {down} bytes down"
                    ),
                    Err(e) => log_line!(Level::Debug, "llm-proxy: CONNECT relay for {host} ended: {e}"),
                }
            }
            Err(e) => log_line!(
                Level::Warn,
                "llm-proxy: CONNECT {authority} upgrade failed: {e}"
            ),
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
                "llm-proxy: origin-form request without LLM_PROXY_UPSTREAM_URL; send an absolute URI or set LLM_PROXY_UPSTREAM_URL",
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

/// Proxy version, printed in the startup log. Bump manually on releases.
const VERSION: &str = "0.1.0";

#[tokio::main]
async fn main() {
    init_logging();
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

    // No LLM_PROXY_UPSTREAM_URL: connect directly to whatever host each request names
    // (absolute-form URIs). Origin-form requests then need LLM_PROXY_UPSTREAM_URL.
    let upstream: Option<String> = env::var("LLM_PROXY_UPSTREAM_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string());
    let listen_addr = env::var("LLM_PROXY_LISTEN_ADDR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:8899".into());
    let log_path = env::var("LLM_PROXY_LLM_LOGFILE")
        .ok()
        .filter(|s| !s.trim().is_empty());

    let log_file = match &log_path {
        Some(path) => {
            if let Some(parent) = Path::new(path).parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log_line!(Level::Warn, "llm-proxy: cannot create LLM_PROXY_LLM_LOGFILE dir {}: {e}", parent.display());
                }
            }
            Some(Arc::new(Mutex::new(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .expect("open LLM_PROXY_LLM_LOGFILE"),
            )))
        }
        None => None,
    };
    let log_bodies = env::var("LLM_PROXY_LLM_LOG_BODIES").is_ok_and(|v| v == "1");

    let (tls_min, tls_max, tls_versions) = tls_bounds_or_exit();

    let mut client_builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if upstream_cert_verification_disabled() {
        client_builder = client_builder.danger_accept_invalid_certs(true);
    }
    if let Some(v) = tls_min {
        client_builder = client_builder.min_tls_version(reqwest_tls_version(v));
    }
    if let Some(v) = tls_max {
        client_builder = client_builder.max_tls_version(reqwest_tls_version(v));
    }

    let upstream_proxy = env::var("LLM_PROXY_UPSTREAM_PROXY").unwrap_or_default();
    // Note: an unset LLM_PROXY_UPSTREAM_PROXY means direct, NOT env fallback. The
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
            let proxy = reqwest::Proxy::all(normalized.as_str()).expect("invalid LLM_PROXY_UPSTREAM_PROXY");
            client_builder = client_builder.proxy(proxy);
            redact_proxy_url(&normalized)
        }
    };

    let client = client_builder.build().expect("build reqwest client");

    let tls_desc = match (tls_min, tls_max) {
        (None, None) => "1.3+1.2",
        (Some(2), Some(2)) | (None, Some(2)) => "1.2",
        (Some(3), Some(3)) | (Some(3), None) => "1.3",
        _ => "1.2+1.3",
    }
    .to_string();
    let level_desc = level_name(max_level()).to_string();

    let mitm = init_mitm(tls_versions);
    let mitm_desc = match mitm.as_ref() {
        Some(m) if m.suffixes.is_empty() => "all".to_string(),
        Some(m) => m.suffixes.join(","),
        None => "off".to_string(),
    };

    let state = AppState {
        client,
        upstream: upstream.clone(),
        tunnel_via: parse_tunnel_via(&env::var("LLM_PROXY_UPSTREAM_PROXY").unwrap_or_default()),
        mitm,
        log_file,
        log_bodies,
    };

    let app = Router::new().fallback(proxy_handler).with_state(state);
    let listener = tokio::net::TcpListener::bind(&listen_addr)
        .await
        .expect("bind listen address");

    if upstream_cert_verification_disabled() {
        log_line!(
            Level::Warn,
            "llm-proxy: upstream TLS certificate verification DISABLED via LLM_PROXY_DISABLE_CERT_VERIFICATION"
        );
    }

    log_line!(
        Level::Info,
        "llm-proxy (rust v{VERSION}) listening on http://{listen_addr} -> {route} (upstream proxy: {proxy_desc}, mitm: {mitm_desc}, tls: {tls_desc}, level: {level_desc}, llm-logs: {log_display})",
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
        // ... even with no LLM_PROXY_UPSTREAM_URL configured (direct mode).
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
    fn matches_intercept_suffixes() {
        let suffixes = parse_suffixes("cognitiveservices.azure.com, services.ai.azure.com");
        assert!(intercept_host(
            "ais123.cognitiveservices.azure.com",
            &suffixes
        ));
        assert!(intercept_host("COGNITIVESERVICES.AZURE.COM", &suffixes));
        assert!(!intercept_host("opencode.ai", &suffixes));
        assert!(!intercept_host("notazure.com", &suffixes));
        assert!(!intercept_host("", &suffixes));
        assert!(intercept_host("anything.example.com", &parse_suffixes("*")));
        // No configured suffixes: intercept everything.
        assert!(intercept_host("anything.example.com", &[]));
        assert!(intercept_host("opencode.ai", &[]));
        assert!(!intercept_host("", &[]));
    }

    #[test]
    fn splits_connect_authority() {
        assert_eq!(authority_host("example.com:443"), "example.com");
        assert_eq!(authority_host("example.com"), "example.com");
        assert_eq!(authority_host("[::1]:443"), "::1");
        assert_eq!(connect_port("example.com:443"), Some(443));
        assert_eq!(connect_port("example.com"), None);
        assert_eq!(connect_port("example.com:80"), Some(80));
    }

    /// Throwaway in-memory CA for tests (production CAs are provisioned
    /// separately via openssl and loaded with `load_ca_authority`).
    #[cfg(test)]
    fn test_issuer() -> rcgen::CertifiedIssuer<'static, KeyPair> {
        use rcgen::{IsCa, BasicConstraints, KeyUsagePurpose};
        let mut params =
            CertificateParams::new(vec!["llm-proxy test CA".to_string()]).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
        ];
        let key = KeyPair::generate().unwrap();
        rcgen::CertifiedIssuer::self_signed(params, key).unwrap()
    }

    #[tokio::test]
    async fn mitm_negotiates_the_same_alpn_on_both_sides() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let issuer = test_issuer();
        let mut roots = RootCertStore::empty();
        roots.add(issuer.der().clone()).unwrap();
        let (cert_der, key_der) = issue_leaf(&issuer, "upstream.example.com").unwrap();
        let mut cfg = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert_der)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
            )
            .unwrap();
        let h2 = b"h2".to_vec();
        let http1 = b"http/1.1".to_vec();
        cfg.alpn_protocols = vec![h2.clone(), http1.clone()];
        let cached_cfg = Arc::new(cfg);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for (client_alpn, upstream_alpn, expected) in [
            (
                vec![h2.clone(), http1.clone()],
                vec![http1.clone()],
                Some(http1.clone()),
            ),
            (
                vec![h2.clone(), http1.clone()],
                vec![h2.clone()],
                Some(h2.clone()),
            ),
            (
                vec![http1.clone()],
                vec![h2.clone(), http1.clone()],
                Some(http1.clone()),
            ),
            (vec![], vec![h2.clone(), http1.clone()], None),
            (vec![h2.clone(), http1.clone()], vec![], None),
        ] {
            let cc = ClientConfig::builder()
                .with_root_certificates(roots.clone())
                .with_no_client_auth();
            let mut client_cfg = cc.clone();
            client_cfg.alpn_protocols = client_alpn;
            let mut upstream_cfg = (*cached_cfg).clone();
            upstream_cfg.alpn_protocols = upstream_alpn;
            let upstream_tcp = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (upstream_io, _) = listener.accept().await.unwrap();
            let (client_io, proxy_io) = tokio::io::duplex(16384);
            let name = ServerName::try_from("upstream.example.com").unwrap();
            let (client, proxy, upstream) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(
                    tokio_rustls::TlsConnector::from(Arc::new(client_cfg))
                        .connect(name.clone(), client_io),
                    mitm_handshake(proxy_io, upstream_tcp, cached_cfg.clone(), cc, name, "upstream.example.com"),
                    tokio_rustls::TlsAcceptor::from(Arc::new(upstream_cfg)).accept(upstream_io),
                )
            })
            .await
            .expect("MITM handshake timed out");
            let client = client.expect("client handshake");
            let (proxy_client, proxy_upstream) = proxy.expect("proxy handshake");
            let upstream = upstream.expect("upstream handshake");
            for selected in [
                client.get_ref().1.alpn_protocol(),
                proxy_client.get_ref().1.alpn_protocol(),
                proxy_upstream.get_ref().1.alpn_protocol(),
                upstream.get_ref().1.alpn_protocol(),
            ] {
                assert_eq!(selected, expected.as_deref());
            }
            assert_eq!(cached_cfg.alpn_protocols, vec![h2.clone(), http1.clone()]);
        }
    }

    #[test]
    fn handshake_failure_reason_maps_every_variant() {
        use rustls::{
            AlertDescription, CertificateError, ContentType, HandshakeType, InvalidMessage,
            PeerIncompatible, PeerMisbehaved,
        };
        use std::collections::HashSet;
        let cases: &[(&rustls::Error, &str)] = &[
            (
                &rustls::Error::AlertReceived(AlertDescription::HandshakeFailure),
                "tls.handshake.failed.alert_received",
            ),
            (
                &rustls::Error::PeerIncompatible(PeerIncompatible::NoCipherSuitesInCommon),
                "tls.handshake.failed.peer_incompatible",
            ),
            (
                &rustls::Error::PeerMisbehaved(PeerMisbehaved::IllegalMiddleboxChangeCipherSpec),
                "tls.handshake.failed.peer_misbehaved",
            ),
            (
                &rustls::Error::InvalidMessage(InvalidMessage::InvalidContentType),
                "tls.handshake.failed.invalid_message",
            ),
            (
                &rustls::Error::InappropriateMessage {
                    expect_types: vec![ContentType::Handshake],
                    got_type: ContentType::ApplicationData,
                },
                "tls.handshake.failed.inappropriate_message",
            ),
            (
                &rustls::Error::InappropriateHandshakeMessage {
                    expect_types: vec![HandshakeType::ClientHello],
                    got_type: HandshakeType::Finished,
                },
                "tls.handshake.failed.inappropriate_handshake_message",
            ),
            (
                &rustls::Error::PeerSentOversizedRecord,
                "tls.handshake.failed.oversized_record",
            ),
            (
                &rustls::Error::NoApplicationProtocol,
                "tls.handshake.failed.no_alpn",
            ),
            (
                &rustls::Error::InvalidCertificate(CertificateError::Expired),
                "tls.handshake.failed.invalid_certificate",
            ),
            (
                &rustls::Error::DecryptError,
                "tls.handshake.failed.decrypt_error",
            ),
            (
                &rustls::Error::NoCertificatesPresented,
                "tls.handshake.failed.no_certificates_present",
            ),
            (
                &rustls::Error::General("test".to_owned()),
                "tls.handshake.failed.other",
            ),
            (&rustls::Error::EncryptError, "tls.handshake.failed.other"),
            (
                &rustls::Error::FailedToGetCurrentTime,
                "tls.handshake.failed.other",
            ),
            (
                &rustls::Error::HandshakeNotComplete,
                "tls.handshake.failed.other",
            ),
        ];
        let mut seen = HashSet::new();
        for (err, expected) in cases {
            let got = handshake_failure_reason(err);
            assert_eq!(got, *expected, "variant {err:?} → {got}, want {expected}");
            assert!(got.starts_with("tls.handshake.failed."), "reason {got} escaped namespace");
            seen.insert(got);
        }
        assert_eq!(seen.len(), 12, "unexpected key set: {seen:?}");
    }

    #[test]
    fn ca_roundtrip_issues_usable_leaf() {        // ServerConfig::builder() needs the process-default provider (main()
        // installs it in production).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let issuer = test_issuer();
        for host in ["deepseek.example.com", "127.0.0.1"] {
            let (cert_der, key_der) = issue_leaf(&issuer, host).expect("issue leaf");
            assert!(!cert_der.is_empty() && !key_der.is_empty());
            // Leaf must build a working server config.
            let mut cfg = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(cert_der)],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
                )
                .expect("server config");
            cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        }
    }

    #[test]
    fn missing_ca_disables_mitm_with_actionable_error() {
        let dir = std::env::temp_dir().join(format!("llm-proxy-test-{}", std::process::id()));
        let err = match load_ca_authority(
            &dir.join("does-not-exist-cert.pem"),
            &dir.join("does-not-exist-key.pem"),
        ) {
            Ok(_) => panic!("must fail without CA files"),
            Err(e) => e,
        };
        assert!(err.contains("baked into the image"), "{err}");
    }

    #[test]
    fn tls_version_matrix() {
        // Parsing: only "1.2"/"1.3" (or empty = unset) are accepted.
        assert_eq!(parse_tls_version("", "V").unwrap(), None);
        assert_eq!(parse_tls_version("  ", "V").unwrap(), None);
        assert_eq!(parse_tls_version("1.2", "V").unwrap(), Some(2));
        assert_eq!(parse_tls_version("1.3", "V").unwrap(), Some(3));
        for bad in ["1.0", "1.1", "tls1.2", "2", "12", "v1.3"] {
            assert!(parse_tls_version(bad, "V").is_err(), "{bad}");
        }
        // (min, max) matrix; true = enabled.
        let matrix: Vec<(Option<u8>, Option<u8>, bool, bool)> = vec![
            (None, None, true, true),       // default
            (None, Some(2), false, true),   // max 1.2
            (None, Some(3), true, true),    // max 1.3: no-op
            (Some(2), None, true, true),    // min 1.2: no-op
            (Some(2), Some(2), false, true),
            (Some(2), Some(3), true, true),
            (Some(3), None, true, false),   // min 1.3
            (Some(3), Some(3), true, false),
        ];
        for (min, max, v13, v12) in matrix {
            let versions = tls_versions(min, max).unwrap();
            assert_eq!(
                versions.len(),
                usize::from(v13) + usize::from(v12),
                "min={min:?} max={max:?}"
            );
            assert_eq!(versions.contains(&&TLS13), v13, "min={min:?} max={max:?}");
            assert_eq!(versions.contains(&&TLS12), v12, "min={min:?} max={max:?}");
        }
        // Contradiction and invalid input are startup errors.
        assert!(tls_versions(Some(3), Some(2)).is_err());
        assert!(parse_tls_version("1.1", "LLM_PROXY_TLS_MIN_VERSION").is_err());
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

    #[test]
    fn parses_log_levels() {
        assert_eq!(parse_log_level("").unwrap(), Level::Info);
        assert_eq!(parse_log_level("  ").unwrap(), Level::Info);
        assert_eq!(parse_log_level("INFO").unwrap(), Level::Info);
        assert_eq!(parse_log_level("info").unwrap(), Level::Info);
        assert_eq!(parse_log_level("ERROR").unwrap(), Level::Error);
        assert_eq!(parse_log_level("warn").unwrap(), Level::Warn);
        assert_eq!(parse_log_level("WARNING").unwrap(), Level::Warn);
        assert_eq!(parse_log_level("Debug").unwrap(), Level::Debug);
        for bad in ["TRACE", "verbose", "1", "warningg"] {
            assert!(parse_log_level(bad).is_err(), "{bad}");
        }
        // Ordering: Error < Warn < Info < Debug (level > max means filtered).
        assert!(Level::Error < Level::Warn);
        assert!(Level::Warn < Level::Info);
        assert!(Level::Info < Level::Debug);
    }

    #[test]
    fn parses_disable_cert_verification() {
        for on in ["1", "true", "TRUE", "yes", "on", " On "] {
            assert!(cert_verification_disabled_raw(on), "{on}");
        }
        for off in ["", " ", "0", "false", "no", "off", "2"] {
            assert!(!cert_verification_disabled_raw(off), "{off}");
        }
    }
}
