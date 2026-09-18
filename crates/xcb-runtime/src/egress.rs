use crate::{Error, Result};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UnixListener, UnixStream},
    task::JoinSet,
};

const MAX_HANDSHAKE_BYTES: usize = 4 * 1024;
const HANDSHAKE_MS: u64 = 5_000;
const MAX_CONNECTIONS: usize = 64;
const IDLE_MS: u64 = 30_000;
const MAX_HOST_BYTES: usize = 253;
const DIAL_MS: u64 = 15_000;

fn hostname(value: &str) -> Result<String> {
    let lowered = value.to_lowercase();
    if lowered.is_empty()
        || lowered.len() > MAX_HOST_BYTES
        || !lowered
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:[]-".contains(&b))
    {
        return Err(Error::Protocol("egress host invalid"));
    }
    Ok(lowered)
}

fn private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = path.symlink_metadata()?;
    if !meta.is_dir()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.mode() & 0o777 != 0o700
        || path.canonicalize()? != path
    {
        return Err(Error::PrivateState);
    }
    Ok(())
}

fn parse_handshake(head: &[u8], allowed_port: u16) -> Result<(String, u16)> {
    let text =
        std::str::from_utf8(head).map_err(|_| Error::Protocol("egress handshake encoding"))?;
    let request = text.split("\r\n").next().unwrap_or_default();
    let authority = request
        .strip_prefix("CONNECT ")
        .and_then(|rest| {
            rest.strip_suffix(" HTTP/1.0")
                .or_else(|| rest.strip_suffix(" HTTP/1.1"))
        })
        .ok_or(Error::Protocol("egress method unsupported"))?;
    let (host, port_text) = if let Some(stripped) = authority.strip_prefix('[') {
        let (host, port) = stripped
            .split_once("]:")
            .ok_or(Error::Protocol("egress authority invalid"))?;
        (format!("[{host}]"), port)
    } else {
        let (host, port) = authority
            .split_once(':')
            .ok_or(Error::Protocol("egress authority invalid"))?;
        (host.to_owned(), port)
    };
    let host = hostname(&host)?;
    let port: u16 = port_text
        .parse()
        .map_err(|_| Error::Protocol("egress port unsupported"))?;
    if port != allowed_port {
        return Err(Error::Protocol("egress port unsupported"));
    }
    Ok((host, port))
}

async fn read_head(stream: &mut (impl AsyncReadExt + Unpin)) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let count = stream.read(&mut byte).await?;
        if count == 0 {
            return Err(Error::Protocol("egress handshake ended"));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            head.truncate(head.len() - 4);
            return Ok(head);
        }
        if head.len() > MAX_HANDSHAKE_BYTES {
            return Err(Error::Protocol("egress handshake limit"));
        }
    }
}

#[derive(Default)]
struct Counters {
    accepted: AtomicU64,
    refused: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

async fn forwarder_conn(
    mut inbound: TcpStream,
    upstream_path: &Path,
    allowed_port: u16,
    counters: &Counters,
) -> Result<()> {
    let head = read_head(&mut inbound).await?;
    let request =
        std::str::from_utf8(&head).map_err(|_| Error::Protocol("forwarder head encoding"))?;
    let first = request.split("\r\n").next().unwrap_or_default();
    let authority = first
        .strip_prefix("CONNECT ")
        .and_then(|rest| {
            rest.strip_suffix(" HTTP/1.0")
                .or_else(|| rest.strip_suffix(" HTTP/1.1"))
        })
        .ok_or(Error::Protocol("forwarder refused CONNECT"))?;
    let suffix = format!(":{allowed_port}");
    let valid = authority.strip_suffix(&suffix).is_some_and(|host| {
        !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    });
    if !valid {
        counters.refused.fetch_add(1, Ordering::Relaxed);
        return Err(Error::Protocol("forwarder refused CONNECT"));
    }
    let mut upstream = UnixStream::connect(upstream_path).await?;
    upstream.write_all(&head).await?;
    upstream.write_all(b"\r\n\r\n").await?;
    let reply = read_head(&mut upstream).await?;
    inbound.write_all(&reply).await?;
    inbound.write_all(b"\r\n\r\n").await?;
    counters.accepted.fetch_add(1, Ordering::Relaxed);
    let (down, up) = tokio::io::copy_bidirectional(&mut inbound, &mut upstream).await?;
    counters.bytes_in.fetch_add(down + up, Ordering::Relaxed);
    Ok(())
}

pub async fn run_forwarder(
    socket: &Path,
    port: u16,
    allowed_port: u16,
    lo_up: Option<&Path>,
    child: &[String],
) -> Result<i32> {
    if child.is_empty() {
        return Err(Error::Unavailable("forwarder requires a child command"));
    }
    if let Some(cap) = read_cap_eff() {
        eprintln!("FWD capEff={cap}");
    }
    if let Some(ip) = lo_up {
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new(ip)
                .args(["link", "set", "lo", "up"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status(),
        )
        .await;
        eprintln!("FWD loUpStatus={status:?}");
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("FWD listening=127.0.0.1:{port}");
    let counters = Arc::new(Counters::default());
    let proxy = format!("http://127.0.0.1:{port}");
    let mut command = tokio::process::Command::new(&child[0]);
    command
        .args(&child[1..])
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .env("http_proxy", &proxy)
        .env("HTTP_PROXY", &proxy)
        .env("https_proxy", &proxy)
        .env("HTTPS_PROXY", &proxy)
        .env("all_proxy", &proxy)
        .env("ALL_PROXY", &proxy)
        .env("no_proxy", "")
        .env("NO_PROXY", "");
    let mut spawned = command.spawn()?;
    let child_pid = spawned
        .id()
        .and_then(|pid| rustix::process::Pid::from_raw(i32::try_from(pid).unwrap_or_default()));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut conns: JoinSet<()> = JoinSet::new();
    let code = loop {
        tokio::select! {
            accept = listener.accept() => {
                match accept {
                    Ok((inbound, _)) => {
                        let counters = counters.clone();
                        let upstream_path = socket.to_owned();
                        conns.spawn(async move {
                            let _ = forwarder_conn(inbound, &upstream_path, allowed_port, &counters)
                                .await;
                        });
                    }
                    Err(_) => continue,
                }
            }
            _ = term.recv() => {
                if let Some(pid) = child_pid {
                    let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
                }
            }
            _ = int.recv() => {
                if let Some(pid) = child_pid {
                    let _ = rustix::process::kill_process(pid, rustix::process::Signal::INT);
                }
            }
            status = spawned.wait() => break status.ok().and_then(|s| s.code()),
        }
    };
    conns.abort_all();
    while conns.join_next().await.is_some() {}
    eprintln!(
        "FWD childExit={code:?} accepted={} refused={}",
        counters.accepted.load(Ordering::Relaxed),
        counters.refused.load(Ordering::Relaxed)
    );
    Ok(code.unwrap_or(1))
}

fn read_cap_eff() -> Option<String> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:").map(|v| v.trim().to_owned()))
}

pub struct EgressBridgeOptions {
    pub socket_path: PathBuf,
    pub allowlist: Option<BTreeSet<String>>,
    pub max_connections: usize,
    pub idle_timeout: Duration,
    pub allowed_port: u16,
}
impl EgressBridgeOptions {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            allowlist: None,
            max_connections: MAX_CONNECTIONS,
            idle_timeout: Duration::from_millis(IDLE_MS),
            allowed_port: 443,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressBridgeReceipt {
    pub socket_path: PathBuf,
    pub production_qualified: bool,
    pub connections_accepted: u64,
    pub connections_refused: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub listener_closed: bool,
    pub sockets_joined: bool,
    pub socket_removed: bool,
}

pub struct EgressBridge {
    socket_path: PathBuf,
    counters: Arc<Counters>,
    connections: Arc<AtomicUsize>,
    shutdown: tokio::sync::watch::Sender<bool>,
    accept_task: tokio::task::JoinHandle<JoinSet<()>>,
}

impl EgressBridge {
    pub async fn start(options: EgressBridgeOptions) -> Result<Self> {
        if options.max_connections == 0 || options.max_connections > MAX_CONNECTIONS {
            return Err(Error::Unavailable("egress connection limit invalid"));
        }
        if options.idle_timeout < Duration::from_secs(1)
            || options.idle_timeout > Duration::from_secs(300)
        {
            return Err(Error::Unavailable("egress idle timeout invalid"));
        }
        let socket_path = options.socket_path;
        if socket_path.exists() || socket_path.symlink_metadata().is_ok() {
            return Err(Error::Unavailable("egress socket exists"));
        }
        let parent = socket_path.parent().ok_or(Error::PrivateState)?.to_owned();
        private_directory(&parent)?;
        let allowlist = options
            .allowlist
            .map(|set| {
                if set.len() > 256 {
                    return Err(Error::Unavailable("egress allowlist invalid"));
                }
                set.iter()
                    .map(|h| hostname(h))
                    .collect::<Result<BTreeSet<_>>>()
            })
            .transpose()?
            .map(Arc::new);
        let listener = UnixListener::bind(&socket_path)?;
        std::fs::set_permissions(
            &socket_path,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )?;
        let counters = Arc::new(Counters::default());
        let connections = Arc::new(AtomicUsize::new(0));
        let (shutdown, mut closing) = tokio::sync::watch::channel(false);
        let max_connections = options.max_connections;
        let allowed_port = options.allowed_port;
        let idle_timeout = options.idle_timeout;
        let accept_task = {
            let counters = counters.clone();
            let connections = connections.clone();
            tokio::spawn(async move {
                let mut conns: JoinSet<()> = JoinSet::new();
                loop {
                    tokio::select! {
                        accept = listener.accept() => {
                            match accept {
                                Ok((inbound, _)) => {
                                    if connections.load(Ordering::Relaxed) >= max_connections {
                                        counters.refused.fetch_add(1, Ordering::Relaxed);
                                        drop(inbound);
                                        continue;
                                    }
                                    connections.fetch_add(1, Ordering::Relaxed);
                                    let counters = counters.clone();
                                    let connections = connections.clone();
                                    let allowlist = allowlist.clone();
                                    conns.spawn(async move {
                                        let _guard = ConnGuard(connections);
                                        if serve_conn(
                                            inbound,
                                            allowed_port,
                                            allowlist.as_deref(),
                                            idle_timeout,
                                            &counters,
                                        )
                                        .await
                                        .is_err()
                                        {
                                            counters.refused.fetch_add(1, Ordering::Relaxed);
                                        }
                                    });
                                }
                                Err(_) => break,
                            }
                        }
                        _ = closing.changed() => break,
                    }
                }
                conns
            })
        };
        Ok(Self {
            socket_path,
            counters,
            connections,
            shutdown,
            accept_task,
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }

    pub async fn close(mut self) -> EgressBridgeReceipt {
        let _ = self.shutdown.send(true);
        let sockets_joined =
            match tokio::time::timeout(Duration::from_millis(HANDSHAKE_MS), &mut self.accept_task)
                .await
            {
                Ok(Ok(mut conns)) => {
                    conns.abort_all();
                    while conns.join_next().await.is_some() {}
                    self.connections.load(Ordering::Relaxed) == 0
                }
                _ => {
                    self.accept_task.abort();
                    false
                }
            };
        let socket_removed = match std::fs::remove_file(&self.socket_path) {
            Ok(()) => true,
            Err(_) => !self.socket_path.exists(),
        };
        EgressBridgeReceipt {
            socket_path: self.socket_path.clone(),
            production_qualified: false,
            connections_accepted: self.counters.accepted.load(Ordering::Relaxed),
            connections_refused: self.counters.refused.load(Ordering::Relaxed),
            bytes_in: self.counters.bytes_in.load(Ordering::Relaxed),
            bytes_out: self.counters.bytes_out.load(Ordering::Relaxed),
            listener_closed: true,
            sockets_joined,
            socket_removed,
        }
    }
}

impl Drop for EgressBridge {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.accept_task.abort();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

struct ConnGuard(Arc<AtomicUsize>);
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn serve_conn(
    mut inbound: UnixStream,
    allowed_port: u16,
    allowlist: Option<&BTreeSet<String>>,
    idle_timeout: Duration,
    counters: &Counters,
) -> Result<()> {
    let head = tokio::time::timeout(Duration::from_millis(HANDSHAKE_MS), read_head(&mut inbound))
        .await
        .map_err(|_| Error::Unavailable("egress handshake timed out"))??;
    let (host, port) = parse_handshake(&head, allowed_port)?;
    if let Some(list) = allowlist
        && !list.contains(&host)
    {
        inbound
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await?;
        return Err(Error::Protocol("egress host not allowed"));
    }
    let dial = TcpStream::connect((host.as_str(), port));
    let mut upstream = match tokio::time::timeout(Duration::from_millis(DIAL_MS), dial).await {
        Ok(Ok(stream)) => stream,
        _ => {
            inbound
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await?;
            return Err(Error::Unavailable("egress dial failed"));
        }
    };
    upstream.set_nodelay(true).ok();
    counters.accepted.fetch_add(1, Ordering::Relaxed);
    inbound
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    relay(&mut inbound, &mut upstream, idle_timeout, counters).await
}

async fn relay(
    inbound: &mut UnixStream,
    upstream: &mut TcpStream,
    idle_timeout: Duration,
    counters: &Counters,
) -> Result<()> {
    let mut buf_in = [0u8; 16 * 1024];
    let mut buf_up = [0u8; 16 * 1024];
    let mut in_open = true;
    let mut up_open = true;
    while in_open || up_open {
        let step = tokio::time::timeout(idle_timeout, async {
            tokio::select! {
                read = inbound.read(&mut buf_in), if in_open => {
                    match read {
                        Ok(0) => { in_open = false; upstream.shutdown().await?; }
                        Ok(n) => {
                            counters.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
                            upstream.write_all(&buf_in[..n]).await?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                read = upstream.read(&mut buf_up), if up_open => {
                    match read {
                        Ok(0) => { up_open = false; inbound.shutdown().await?; }
                        Ok(n) => {
                            counters.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
                            inbound.write_all(&buf_up[..n]).await?;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            Ok::<(), Error>(())
        })
        .await;
        match step {
            Ok(Ok(())) => {}
            Ok(Err(_)) => break,
            Err(_) => return Err(Error::Unavailable("egress connection idle")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn private_root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    #[test]
    fn handshake_parses_connect_host_port() {
        assert_eq!(
            parse_handshake(b"CONNECT api.anthropic.com:443 HTTP/1.1", 443).unwrap(),
            ("api.anthropic.com".to_owned(), 443)
        );
        assert!(parse_handshake(b"CONNECT api.anthropic.com:80 HTTP/1.1", 443).is_err());
        assert!(parse_handshake(b"GET / HTTP/1.1", 443).is_err());
        assert!(parse_handshake(b"CONNECT bad host:443 HTTP/1.1", 443).is_err());
        assert_eq!(
            parse_handshake(b"CONNECT example.com:8080 HTTP/1.0", 8080).unwrap(),
            ("example.com".to_owned(), 8080)
        );
        assert_eq!(
            parse_handshake(b"CONNECT [::1]:443 HTTP/1.1", 443).unwrap(),
            ("[::1]".to_owned(), 443)
        );
    }

    #[tokio::test]
    async fn bridge_rejects_socket_in_nonprivate_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let opts = EgressBridgeOptions::new(dir.path().join("e.sock"));
        assert!(EgressBridge::start(opts).await.is_err());
    }

    #[tokio::test]
    async fn bridge_serves_connect_and_relays_bytes() {
        let echo_port = echo_server().await;
        let root = private_root();
        let socket_path = root.path().canonicalize().unwrap().join("e.sock");
        let mut opts = EgressBridgeOptions::new(socket_path.clone());
        opts.allowed_port = echo_port;
        let bridge = EgressBridge::start(opts).await.unwrap();
        let mut client = UnixStream::connect(&socket_path).await.unwrap();
        client
            .write_all(format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reply = vec![0u8; 64];
        let n = client.read(&mut reply).await.unwrap();
        assert!(String::from_utf8_lossy(&reply[..n]).contains("200 Connection Established"));
        client.write_all(b"ping-through-bridge").await.unwrap();
        let mut echoed = vec![0u8; 19];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping-through-bridge");
        let receipt = bridge.close().await;
        assert!(receipt.connections_accepted >= 1);
        assert!(receipt.listener_closed && receipt.socket_removed && !receipt.production_qualified);
    }

    #[tokio::test]
    async fn bridge_refuses_wrong_port_and_unlisted_host() {
        let root = private_root();
        let socket_path = root.path().canonicalize().unwrap().join("e.sock");
        let mut opts = EgressBridgeOptions::new(socket_path.clone());
        opts.allowlist = Some(BTreeSet::from(["allowed.example".to_owned()]));
        let bridge = EgressBridge::start(opts).await.unwrap();
        let mut client = UnixStream::connect(&socket_path).await.unwrap();
        client
            .write_all(b"CONNECT evil.example:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut reply = vec![0u8; 64];
        let n = client.read(&mut reply).await.unwrap();
        assert!(String::from_utf8_lossy(&reply[..n]).contains("403"));
        let receipt = bridge.close().await;
        assert_eq!(receipt.connections_accepted, 0);
        assert!(receipt.connections_refused >= 1);
    }

    #[tokio::test]
    async fn forwarder_connects_loopback_to_bridge() {
        let echo_port = echo_server().await;
        let root = private_root();
        let socket_path = root.path().canonicalize().unwrap().join("e.sock");
        let mut opts = EgressBridgeOptions::new(socket_path.clone());
        opts.allowed_port = echo_port;
        let _bridge = EgressBridge::start(opts).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fwd_port = listener.local_addr().unwrap().port();
        let socket = socket_path.clone();
        let fwd = tokio::spawn(async move {
            let counters = Counters::default();
            let (inbound, _) = listener.accept().await.unwrap();
            forwarder_conn(inbound, &socket, echo_port, &counters).await
        });
        let mut client = TcpStream::connect(("127.0.0.1", fwd_port)).await.unwrap();
        client
            .write_all(format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reply = vec![0u8; 64];
        let n = client.read(&mut reply).await.unwrap();
        assert!(String::from_utf8_lossy(&reply[..n]).contains("200"));
        client.write_all(b"tunneled").await.unwrap();
        let mut echoed = vec![0u8; 8];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"tunneled");
        drop(client);
        assert!(fwd.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn forwarder_refuses_non_connect_and_wrong_port() {
        let counters = Counters::default();
        let socket = PathBuf::from("/nonexistent.sock");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let counters2 = Arc::new(counters);
        {
            let counters = counters2.clone();
            tokio::spawn(async move {
                let (inbound, _) = listener.accept().await.unwrap();
                let _ = forwarder_conn(inbound, &socket, 443, &counters).await;
            });
        }
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"CONNECT example.com:80 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 16];
        let read = client.read(&mut buf).await.unwrap();
        assert_eq!(read, 0, "refused CONNECT must close, not hang");
        assert_eq!(counters2.refused.load(Ordering::Relaxed), 1);
    }
}
