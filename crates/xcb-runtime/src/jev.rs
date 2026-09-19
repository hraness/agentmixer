//! TypeSafe System One ("jev") judgment backend.
//!
//! One POST carries a bounded state plus a bounded batch of questions; the
//! response is a name-keyed answer map validated strictly before callers see
//! it. The transport is a hand-rolled HTTP/1.1 exchange over rustls — the
//! request and response are fully bounded and there are no redirects, proxies,
//! or retries to audit.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use xcb_core::{Id, bounded_text};
use zeroize::Zeroizing;

use crate::{Error, Result};

use crate::judge::{
    Judge, JudgeAnswer, JudgeAnswers, JudgeQuestions, check_answers, check_questions, check_state,
};

pub const SYSTEM_ONE_URL: &str = "https://api.typesafe.ai/v1/systemone";
pub const DEFAULT_MODEL: &str = "jev-latest";
pub const JUDGE_URL_ENV: &str = "XCB_JEV_URL";
pub const JUDGE_MODEL_ENV: &str = "XCB_JEV_MODEL";

const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One HTTPS endpoint the judge may call. Only `https` with an explicit host
/// is accepted; credentials never travel over plain HTTP.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub path: String,
}

impl Endpoint {
    pub fn authority(&self) -> String {
        if self.port == 443 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    pub fn parse(url: &str) -> Result<Self> {
        bounded_text(url, 1024)?;
        let rest = url
            .strip_prefix("https://")
            .ok_or(xcb_core::Error::Invalid("judge endpoint scheme"))?;
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, format!("/{path}")),
            None => (rest, "/".to_owned()),
        };
        if authority.is_empty() || authority.contains(['@', '?', '#']) {
            return Err(xcb_core::Error::Invalid("judge endpoint authority").into());
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !host.contains(']') => (
                host,
                port.parse::<u16>()
                    .map_err(|_| xcb_core::Error::Invalid("judge endpoint port"))?,
            ),
            _ => (authority, 443),
        };
        if host.is_empty()
            || host.contains(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '.'))
            || ServerName::try_from(host.to_owned()).is_err()
        {
            return Err(xcb_core::Error::Invalid("judge endpoint host").into());
        }
        bounded_text(&path, 1024)?;
        if path
            .bytes()
            .any(|byte| !(0x21..=0x7e).contains(&byte) || matches!(byte, b'?' | b'#'))
        {
            return Err(xcb_core::Error::Invalid("judge endpoint path").into());
        }
        Ok(Self {
            host: host.to_owned(),
            port,
            path,
        })
    }
}

/// The model and endpoint a `SystemOne` backend resolves for this config:
/// config fields first, then the environment overrides, then the built-in
/// defaults. Status output reports this so it shows what the backend would
/// actually use, not just the stored config.
fn target(
    config: &crate::config::JudgeConfig,
    model_env: Option<String>,
    endpoint_env: Option<String>,
) -> Result<(Id, String)> {
    let model = match config.model.clone() {
        Some(model) => model,
        None => Id::new(model_env.unwrap_or_else(|| DEFAULT_MODEL.to_owned()).trim())?,
    };
    let endpoint = config
        .endpoint
        .clone()
        .or(endpoint_env)
        .unwrap_or_else(|| SYSTEM_ONE_URL.to_owned())
        .trim()
        .to_owned();
    Endpoint::parse(&endpoint)?;
    Ok((model, endpoint))
}

pub fn effective_target(config: &crate::config::JudgeConfig) -> Result<(Id, String)> {
    target(
        config,
        std::env::var(JUDGE_MODEL_ENV).ok(),
        std::env::var(JUDGE_URL_ENV).ok(),
    )
}

/// The System One backend: a `Judge` over one bounded HTTPS POST per ask.
pub struct SystemOne {
    endpoint: Endpoint,
    model: String,
    token: Zeroizing<String>,
    connector: TlsConnector,
}

impl SystemOne {
    pub fn new(
        token: Zeroizing<String>,
        model: Option<Id>,
        endpoint: Option<String>,
    ) -> Result<Self> {
        let (model, url) = effective_target(&crate::config::JudgeConfig {
            enabled: true,
            model,
            endpoint,
        })?;
        let endpoint = Endpoint::parse(&url)?;
        let model = model.as_str().to_owned();
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            endpoint,
            model,
            token,
            connector: TlsConnector::from(Arc::new(config)),
        })
    }
}

impl Judge for SystemOne {
    fn ask<'a>(
        &'a self,
        state: &'a serde_json::Value,
        questions: &'a JudgeQuestions,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<JudgeAnswers>> + Send + 'a>>
    {
        Box::pin(async move {
            check_state(state)?;
            check_questions(questions)?;
            let body = serde_json::to_vec(&serde_json::json!({
                "model": self.model,
                "state": state,
                "questions": questions,
            }))
            .map_err(|_| xcb_core::Error::Invalid("judge request"))?;
            let (status, response) = tokio::time::timeout(REQUEST_TIMEOUT, self.exchange(&body))
                .await
                .map_err(|_| Error::Unavailable("judge request timed out"))??;
            let answers = parse_response(status, &response)?;
            check_answers(questions, &answers)?;
            Ok(answers)
        })
    }
}

impl SystemOne {
    async fn exchange(&self, body: &[u8]) -> Result<(u16, Vec<u8>)> {
        let server = ServerName::try_from(self.endpoint.host.clone())
            .map_err(|_| xcb_core::Error::Invalid("judge endpoint host"))?;
        let addresses =
            tokio::net::lookup_host((self.endpoint.host.as_str(), self.endpoint.port)).await?;
        let mut last = Error::Unavailable("judge endpoint unreachable");
        let mut stream = None;
        for address in addresses.take(8) {
            match TcpStream::connect(address).await {
                Ok(tcp) => {
                    stream = Some(tcp);
                    break;
                }
                Err(error) => last = Error::Io(error),
            }
        }
        let stream = stream.ok_or(last)?;
        let mut tls = self.connector.connect(server, stream).await?;
        let request = format!(
            "POST {} HTTP/1.1\r\nhost: {}\r\nauthorization: Bearer {}\r\ncontent-type: application/json\r\naccept: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            self.endpoint.path,
            self.endpoint.authority(),
            self.token.as_str(),
            body.len(),
        );
        tls.write_all(request.as_bytes()).await?;
        tls.write_all(body).await?;
        tls.flush().await?;
        read_response(&mut tls).await
    }
}

/// Reads one bounded HTTP/1.1 response: status line, headers, then a body by
/// Content-Length, chunked coding, or connection close (we request `close`).
async fn read_response<S: AsyncReadExt + Unpin>(stream: &mut S) -> Result<(u16, Vec<u8>)> {
    let mut buffer = Vec::with_capacity(16 * 1024);
    let header_end = loop {
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(xcb_core::Error::Limit("judge response headers").into());
        }
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(Error::Unavailable("judge connection closed before headers"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&buffer) {
            break end;
        }
    };
    let head = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| Error::Unavailable("judge response not utf-8"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .strip_prefix("HTTP/1.")
        .and_then(|rest| rest.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(Error::Unavailable("judge response malformed"))?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                content_length = value.trim().parse::<usize>().ok();
            }
            "transfer-encoding" if value.trim().eq_ignore_ascii_case("chunked") => {
                chunked = true;
            }
            _ => {}
        }
    }
    let mut body = buffer.split_off(header_end);
    if chunked {
        body = read_chunked(stream, body).await?;
    } else if let Some(length) = content_length {
        if length > MAX_RESPONSE_BYTES {
            return Err(xcb_core::Error::Limit("judge response").into());
        }
        while body.len() < length {
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(Error::Unavailable("judge response truncated"));
            }
            body.extend_from_slice(&chunk[..read]);
            if body.len() > MAX_RESPONSE_BYTES {
                return Err(xcb_core::Error::Limit("judge response").into());
            }
        }
        body.truncate(length);
    } else {
        // `connection: close` terminates the body; still bounded.
        loop {
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
            if body.len() > MAX_RESPONSE_BYTES {
                return Err(xcb_core::Error::Limit("judge response").into());
            }
        }
    }
    Ok((status, body))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

async fn read_chunked<S: AsyncReadExt + Unpin>(
    stream: &mut S,
    mut body: Vec<u8>,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let size_line = loop {
            if let Some(position) = body.windows(2).position(|w| w == b"\r\n") {
                let line = body.drain(..position + 2).collect::<Vec<u8>>();
                break line;
            }
            if body.len() > 4096 {
                return Err(xcb_core::Error::Limit("judge chunk header").into());
            }
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(Error::Unavailable("judge response truncated"));
            }
            body.extend_from_slice(&chunk[..read]);
        };
        let size_text = std::str::from_utf8(&size_line[..size_line.len().saturating_sub(2)])
            .map_err(|_| Error::Unavailable("judge chunk malformed"))?;
        let size = usize::from_str_radix(size_text.trim().split(';').next().unwrap_or(""), 16)
            .map_err(|_| Error::Unavailable("judge chunk malformed"))?;
        if size == 0 {
            return Ok(output);
        }
        if output.len() + size > MAX_RESPONSE_BYTES {
            return Err(xcb_core::Error::Limit("judge response").into());
        }
        while body.len() < size + 2 {
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(Error::Unavailable("judge response truncated"));
            }
            body.extend_from_slice(&chunk[..read]);
        }
        output.extend_from_slice(&body[..size]);
        if &body[size..size + 2] != b"\r\n" {
            return Err(Error::Unavailable("judge chunk malformed"));
        }
        body.drain(..size + 2);
    }
}

#[derive(Deserialize)]
struct RawResponse {
    #[serde(default)]
    model: Option<String>,
    answers: BTreeMap<String, serde_json::Value>,
}

/// Validates a System One response body; rejects anything but an `answers`
/// object whose entries match their question's answer shape.
pub fn parse_response(status: u16, body: &[u8]) -> Result<JudgeAnswers> {
    if !(200..300).contains(&status) {
        return Err(Error::Unavailable(match status {
            401 | 403 => "judge key rejected",
            429 => "judge rate limited",
            _ => "judge request failed",
        }));
    }
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(xcb_core::Error::Limit("judge response").into());
    }
    let raw: RawResponse = serde_json::from_slice(body)
        .map_err(|_| Error::Unavailable("judge returned malformed JSON"))?;
    let mut answers = BTreeMap::new();
    for (name, value) in raw.answers {
        Id::new(&name).map_err(|_| Error::Unavailable("judge answer name malformed"))?;
        answers.insert(name, parse_answer(&value)?);
    }
    if answers.is_empty() {
        return Err(Error::Unavailable("judge response is missing answers"));
    }
    let model = raw
        .model
        .map(Id::new)
        .transpose()
        .map_err(|_| Error::Unavailable("judge response model malformed"))?
        .map(String::from);
    Ok(JudgeAnswers { answers, model })
}

fn finite(value: Option<&serde_json::Value>) -> Result<f64> {
    value
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
        .ok_or(Error::Unavailable("judge answer malformed"))
}

fn probability(value: Option<&serde_json::Value>) -> Result<f64> {
    finite(value).and_then(|probability| {
        (0.0..=1.0)
            .contains(&probability)
            .then_some(probability)
            .ok_or(Error::Unavailable("judge answer out of range"))
    })
}

fn probabilities(value: Option<&serde_json::Value>) -> Result<BTreeMap<String, f64>> {
    let object = value
        .and_then(|value| value.as_object())
        .filter(|object| !object.is_empty())
        .ok_or(Error::Unavailable("judge answer malformed"))?;
    let mut output = BTreeMap::new();
    for (key, value) in object {
        Id::new(key).map_err(|_| Error::Unavailable("judge probability name malformed"))?;
        output.insert(key.clone(), probability(Some(value))?);
    }
    Ok(output)
}

fn parse_answer(value: &serde_json::Value) -> Result<JudgeAnswer> {
    let object = value
        .as_object()
        .ok_or(Error::Unavailable("judge answer malformed"))?;
    let kinds = ["noul", "choice", "score"]
        .into_iter()
        .filter(|key| object.contains_key(*key))
        .collect::<Vec<_>>();
    if kinds.len() != 1
        || object
            .get("type")
            .is_some_and(|kind| kind.as_str() != Some(kinds[0]))
    {
        return Err(Error::Unavailable("judge answer malformed"));
    }
    match kinds[0] {
        "noul" => Ok(JudgeAnswer::Noul(probability(object.get("noul"))?)),
        "choice" => {
            let choice = object
                .get("choice")
                .and_then(|value| value.as_str())
                .ok_or(Error::Unavailable("judge answer malformed"))?;
            Id::new(choice).map_err(|_| Error::Unavailable("judge choice malformed"))?;
            Ok(JudgeAnswer::Choice {
                choice: choice.to_owned(),
                confidence: probability(object.get("confidence"))?,
                probabilities: probabilities(object.get("probabilities"))?,
            })
        }
        "score" => Ok(JudgeAnswer::Score {
            score: finite(object.get("score"))?,
            confidence: probability(object.get("confidence"))?,
            probabilities: probabilities(object.get("probabilities"))?,
        }),
        _ => unreachable!("one of the three keys above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn respond(bytes: &[u8]) -> Result<(u16, Vec<u8>)> {
        let mut stream: &[u8] = bytes;
        read_response(&mut stream).await
    }

    #[test]
    fn effective_target_rejects_output_and_request_line_injection() {
        let config = crate::config::JudgeConfig::default();
        assert!(target(&config, Some("jev-latest\nforged".into()), None).is_err());
        assert!(
            target(
                &config,
                None,
                Some("https://api.typesafe.ai/v1/systemone\nforged: value".into()),
            )
            .is_err()
        );
        assert!(
            target(
                &config,
                None,
                Some("https://api.typesafe.ai/v1/systemone\tforged".into()),
            )
            .is_err()
        );
        let (model, endpoint) = target(
            &config,
            Some(" jev-test ".into()),
            Some(" https://judge.example/v1/ask ".into()),
        )
        .unwrap();
        assert_eq!(model.as_str(), "jev-test");
        assert_eq!(endpoint, "https://judge.example/v1/ask");
    }

    #[tokio::test]
    async fn parses_a_content_length_response() {
        let (status, body) = respond(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 20\r\n\r\n{\"answers\":{\"a\":{}}}",
        )
        .await
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"{\"answers\":{\"a\":{}}}");
    }

    #[tokio::test]
    async fn parses_a_chunked_response() {
        let (status, body) = respond(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n",
        )
        .await
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"helloworld");
    }

    #[tokio::test]
    async fn parses_a_close_terminated_response() {
        let (status, body) = respond(b"HTTP/1.1 500 boom\r\n\r\nerror text")
            .await
            .unwrap();
        assert_eq!(status, 500);
        assert_eq!(body, b"error text");
    }

    #[tokio::test]
    async fn rejects_oversized_headers_and_bodies() {
        let mut oversized_headers = b"HTTP/1.1 200 OK\r\n".to_vec();
        oversized_headers.extend(std::iter::repeat_n(b'x', MAX_HEADER_BYTES + 1));
        assert!(respond(&oversized_headers).await.is_err());

        let oversized_body = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        );
        assert!(respond(oversized_body.as_bytes()).await.is_err());
    }

    #[tokio::test]
    async fn rejects_truncated_and_malformed_responses() {
        assert!(
            respond(b"HTTP/1.1 200 OK\r\ncontent-length: 64\r\n\r\n{}")
                .await
                .is_err()
        );
        assert!(respond(b"garbage").await.is_err());
        assert!(
            respond(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\nx\r\n0\r\n\r\n")
                .await
                .is_err()
        );
    }
}
