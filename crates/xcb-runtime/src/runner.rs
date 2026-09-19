#[cfg(target_os = "macos")]
use crate::process::environment;
use crate::{
    Error, Result, attachments, auth,
    broker::{self, Workspace},
    claude::{self, Event},
    config::Config,
    context, digest, egress, judge, new_id, now_ms, private,
    process::{Pin, StreamProcess},
    sandbox,
    store::{Store, UsageObservation},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{process::Command, sync::watch};
use xcb_core::{
    Id, MAX_TEXT_BYTES, Provider,
    models::{Mode, ModelChoice},
    policy::{EffectState, Failure, Terminal, TurnFacts},
    session::{Message, MessageProvenance, Role, Session, State, Subagent, classify},
    usage::{QuotaPoint, VelocitySample},
};

pub enum Progress {
    Text { thinking: bool, text: String },
    Tool(String),
    Subagent(Subagent),
    Notice(String),
}
pub type Observer = Arc<dyn Fn(Progress) + Send + Sync>;
pub struct Outcome {
    pub text: String,
    pub facts: TurnFacts,
    pub state: State,
}

pub fn should_idle_export(pane_generation: bool, facts: &TurnFacts, state: State) -> bool {
    !pane_generation
        && state == State::Idle
        && facts.joined
        && facts.effects != EffectState::Uncertain
        && facts.terminal == Terminal::Completed
}

struct Launch {
    command: Command,
    cwd: PathBuf,
    bridge: Option<egress::EgressBridge>,
}

fn provider_args(model: &ModelChoice, tools: bool) -> Vec<String> {
    let mut args = vec![
        "--print".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--tools".into(),
        "".into(),
        "--permission-mode".into(),
        "dontAsk".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--setting-sources".into(),
        "".into(),
        "--strict-mcp-config".into(),
        "--no-session-persistence".into(),
        "--max-turns".into(),
        "32".into(),
    ];
    args.push("--model".into());
    args.push(model.id.as_str().into());
    if let Some(effort) = &model.effort {
        args.push("--effort".into());
        args.push(effort.as_str().into());
    }
    args.push("--settings".into());
    args.push(json!({"disableAllHooks":true,"disableClaudeAiConnectors":true,"autoMemoryEnabled":false,"disableBundledSkills":true,"disableSkillShellExecution":true,"enableWorkflows":false,"workflowKeywordTriggerEnabled":false,"skillOverrides":{"doctor":"off","checkup":"off"}}).to_string());
    if tools {
        args.push("--allowedTools".into());
        args.push(
            broker::descriptors()
                .iter()
                .map(|tool| format!("mcp__xcb__{}", tool["name"].as_str().expect("tool name")))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    args
}

/// The bwrap launch plan the Linux `prepare` actually builds, kept
/// platform-neutral so the planner-acceptance regression test can construct
/// it anywhere. The planner owns the executable and forwarder-runtime binds;
/// `read_only` carries only the dynamic-loader/library closure — repeating a
/// path the plan already mounts used to be a fatal "bind target duplicated".
#[cfg(any(target_os = "linux", test))]
fn linux_spec(
    executable: PathBuf,
    runtime: PathBuf,
    scratch: PathBuf,
    policy_path: PathBuf,
    socket: PathBuf,
    env_file: PathBuf,
    read_only: Vec<PathBuf>,
) -> sandbox::BwrapSpec {
    sandbox::BwrapSpec {
        executable,
        scratch,
        account_home: None,
        policy_path,
        read_only,
        egress: sandbox::Egress::Tcp443Dns,
        socket: Some(socket),
        forwarder: Some(sandbox::Forwarder {
            runtime,
            lo_up: None,
            env_file: Some(env_file),
            port: 48123,
        }),
    }
}

/// Shared-library closure of one dynamic executable via `ldd` — the same
/// contract as qualification/linux-loopback.ts `lddClosure()`: every absolute
/// path in the output (ELF interpreter and DT_NEEDED resolutions alike).
/// Paths stay unresolved here; the planner mounts each resolved file at this
/// declared location. A static executable yields an empty closure.
#[cfg(target_os = "linux")]
fn shared_library_closure(executable: &Path) -> Result<Vec<PathBuf>> {
    let output = std::process::Command::new("ldd").arg(executable).output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let paths: BTreeSet<PathBuf> = text
        .split_whitespace()
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .map(Path::to_owned)
        .collect();
    Ok(paths.into_iter().collect())
}

#[cfg(target_os = "linux")]
fn child_env(
    home: &Path,
    config: &Path,
    tmp: &Path,
    token: Option<&str>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert("TMPDIR".into(), tmp.to_string_lossy().into_owned());
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        config.to_string_lossy().into_owned(),
    );
    env.insert(
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
        "1".into(),
    );
    env.insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into());
    if let Some(token) = token {
        env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), token.to_owned());
    }
    env
}

#[cfg(target_os = "macos")]
async fn prepare(
    pin: &Pin,
    root: &Path,
    model: &ModelChoice,
    token: Option<&str>,
    tools: bool,
) -> Result<Launch> {
    if pin.provider != Provider::Claude || !claude::version_admitted(&pin.version) {
        return Err(Error::Unavailable(
            "native execution requires an admitted Claude adapter; other providers remain unqualified",
        ));
    }
    if !sandbox::available() {
        return Err(Error::Unavailable(
            "native OS confinement is not qualified on this platform; no unsandboxed fallback",
        ));
    }
    let directory = private::directory(&root.join("runs").join(new_id("launch").as_str()))?;
    let executable = pin.snapshot(&directory)?;
    let scratch = private::directory(&directory.join("scratch"))?;
    let cwd = private::directory(&scratch.join("work"))?;
    let home = private::directory(&scratch.join("home"))?;
    let config = private::directory(&scratch.join("config"))?;
    let tmp = private::directory(&home.join("tmp"))?;
    let policy = sandbox::seatbelt(&executable, &scratch)?;
    let policy_path = directory.join("sandbox.sb");
    private::create(&policy_path, policy.as_bytes())?;
    let mut env = environment(&home);
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        config.to_string_lossy().into_owned(),
    );
    env.insert("TMPDIR".into(), tmp.to_string_lossy().into_owned());
    env.insert(
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
        "1".into(),
    );
    env.insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into());
    if let Some(token) = token {
        env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), token.to_owned());
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-f").arg(policy_path).arg(executable);
    command.args(provider_args(model, tools));
    command.env_clear().envs(env).current_dir(&cwd);
    Ok(Launch {
        command,
        cwd,
        bridge: None,
    })
}

#[cfg(target_os = "linux")]
async fn prepare(
    pin: &Pin,
    root: &Path,
    model: &ModelChoice,
    token: Option<&str>,
    tools: bool,
) -> Result<Launch> {
    if pin.provider != Provider::Claude || !claude::version_admitted(&pin.version) {
        return Err(Error::Unavailable(
            "native execution requires an admitted Claude adapter; other providers remain unqualified",
        ));
    }
    let status = sandbox::linux_sandbox(root);
    if !status.qualified {
        return Err(Error::Unavailable(
            "native OS confinement is not qualified on this platform; no unsandboxed fallback",
        ));
    }
    let bwrap = status
        .candidate
        .as_deref()
        .and_then(|path| sandbox::BwrapPin::admit(path).ok())
        .ok_or(Error::Unavailable("bwrap not admitted"))?;
    let directory = private::directory(&root.join("runs").join(new_id("launch").as_str()))?;
    let executable = pin.snapshot(&directory)?;
    let scratch = private::directory(&directory.join("scratch"))?;
    let cwd = private::directory(&scratch.join("work"))?;
    let home = private::directory(&scratch.join("home"))?;
    let config = private::directory(&scratch.join("config"))?;
    let tmp = private::directory(&home.join("tmp"))?;
    let env_file = egress::write_forwarder_env(&scratch, &child_env(&home, &config, &tmp, token))?;
    let socket_dir = private::directory(&directory.join("egress"))?;
    let socket = socket_dir.join("egress.sock");
    let bridge =
        egress::EgressBridge::start(egress::EgressBridgeOptions::new(socket.clone())).await?;
    let xcb = std::env::current_exe()?.canonicalize()?;
    // The planner mounts the executable and the forwarder runtime itself;
    // read_only carries only the shared-library closure the dynamic loader
    // needs — provider snapshot and runtime alike.
    let mut read_only = shared_library_closure(&executable)?;
    read_only.extend(shared_library_closure(&xcb)?);
    let spec = linux_spec(
        executable,
        xcb,
        scratch,
        directory.join("sandbox.json"),
        socket,
        env_file,
        read_only,
    );
    let wrapper_env = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
    let launch = sandbox::bwrap_launch(
        &bwrap,
        &spec,
        &provider_args(model, tools),
        &wrapper_env,
        &cwd,
    )?;
    private::create(&spec.policy_path, launch.policy.as_bytes())?;
    let mut command = Command::new(&bwrap.executable);
    command
        .args(launch.args)
        .env_clear()
        .envs(launch.env)
        .current_dir(&cwd);
    Ok(Launch {
        command,
        cwd,
        bridge: Some(bridge),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn prepare(
    _pin: &Pin,
    _root: &Path,
    _model: &ModelChoice,
    _token: Option<&str>,
    _tools: bool,
) -> Result<Launch> {
    Err(Error::Unavailable(
        "native OS confinement is not supported on this platform",
    ))
}

fn initialize(tools: bool, system: &str) -> Value {
    json!({"type":"control_request","request_id":"xcb_initialize","request":{"subtype":"initialize","sdkMcpServers":if tools { vec!["xcb"] } else { vec![] },"hooks":{},"agents":{},"skills":[],"plugins":[],"systemPrompt":[system],"supportedDialogKinds":[]}})
}

fn mcp_reply(request: &Value, tools: bool, call_result: Option<Value>) -> Result<Value> {
    if request.get("server_name").and_then(Value::as_str) != Some("xcb") || !tools {
        return Err(Error::Protocol("unexpected MCP server"));
    }
    let message = request
        .get("message")
        .ok_or(Error::Protocol("MCP message"))?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(Error::Protocol("MCP version"));
    }
    let result = match message.get("method").and_then(Value::as_str) {
        Some("initialize") => {
            json!({"protocolVersion":message.pointer("/params/protocolVersion").and_then(Value::as_str).ok_or(Error::Protocol("MCP protocol"))?,"capabilities":{"tools":{}},"serverInfo":{"name":"xcb","version":env!("CARGO_PKG_VERSION")}})
        }
        Some("tools/list") => json!({"tools":broker::descriptors()}),
        Some("notifications/initialized") => return Ok(json!({})),
        Some("tools/call") => call_result.ok_or(Error::Protocol("tool call before admission"))?,
        _ => return Err(Error::Protocol("unsupported MCP method")),
    };
    let id = message
        .get("id")
        .filter(|id| id.is_string() || id.is_i64())
        .ok_or(Error::Protocol("MCP request id"))?;
    Ok(json!({"mcp_response":{"jsonrpc":"2.0","id":id,"result":result}}))
}

async fn control(process: &mut StreamProcess, envelope: &Value, response: Value) -> Result<()> {
    let id = envelope
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|id| id.len() <= 160)
        .ok_or(Error::Protocol("control id"))?;
    process.send(&json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})).await
}

pub fn parse_models(value: &Value, now: u64) -> Result<Vec<ModelChoice>> {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or(Error::Protocol("model catalog"))?;
    if models.len() > 128 {
        return Err(Error::Protocol("model catalog limit"));
    }
    let mut choices = BTreeMap::new();
    for model in models {
        let id = Id::new(
            model
                .get("value")
                .or_else(|| model.get("resolvedModel"))
                .and_then(Value::as_str)
                .ok_or(Error::Protocol("model identifier"))?,
        )?;
        let resolved = model
            .get("resolvedModel")
            .and_then(Value::as_str)
            .filter(|resolved| *resolved != id.as_str())
            .map(Id::new)
            .transpose()?;
        let name = model
            .get("displayName")
            .and_then(Value::as_str)
            .ok_or(Error::Protocol("model label"))?;
        xcb_core::label(name, 200)?;
        let efforts = match model.get("supportedEffortLevels") {
            None | Some(Value::Null) => vec![None],
            Some(value) => {
                let values = value.as_array().ok_or(Error::Protocol("model efforts"))?;
                if values.len() > 8 {
                    return Err(Error::Protocol("effort limit"));
                }
                values
                    .iter()
                    .map(|effort| {
                        Ok(Some(Id::new(
                            effort.as_str().ok_or(Error::Protocol("effort value"))?,
                        )?))
                    })
                    .collect::<Result<Vec<_>>>()?
            }
        };
        for effort in efforts {
            let choice = ModelChoice {
                provider: Provider::Claude,
                id: id.clone(),
                label: effort
                    .as_ref()
                    .map(|effort| format!("{name} · {effort}"))
                    .unwrap_or_else(|| name.to_owned()),
                mode: Mode::Fixed,
                resolved: resolved.clone(),
                effort,
                observed_at_ms: now,
            };
            choice.validate()?;
            choices.entry(choice.key()).or_insert(choice);
        }
    }
    Ok(choices.into_values().collect())
}

pub fn validate_init(value: &Value, cwd: &Path, model: &ModelChoice, tools: bool) -> Result<()> {
    let mut expected = if tools {
        broker::descriptors()
            .iter()
            .map(|tool| format!("mcp__xcb__{}", tool["name"].as_str().expect("static tool")))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    expected.sort();
    let inventory = value
        .get("tools")
        .and_then(Value::as_array)
        .ok_or(Error::Protocol("tool inventory"))?;
    let mut actual = inventory
        .iter()
        .map(|tool| {
            tool.as_str()
                .map(str::to_owned)
                .ok_or(Error::Protocol("tool inventory name"))
        })
        .collect::<Result<Vec<_>>>()?;
    actual.sort();
    let empty = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    };
    let servers = value
        .get("mcp_servers")
        .and_then(Value::as_array)
        .ok_or(Error::Protocol("MCP inventory"))?;
    if value
        .get("claude_code_version")
        .and_then(Value::as_str)
        .is_none_or(|version| !claude::version_admitted(version))
        || value.get("cwd").and_then(Value::as_str) != cwd.to_str()
        || value.get("model").and_then(Value::as_str) != Some(model.id.as_str())
        || value.get("apiKeySource").and_then(Value::as_str) != Some("none")
        || value.get("permissionMode").and_then(Value::as_str) != Some("dontAsk")
        || actual != expected
        || !empty("skills")
        || !empty("plugins")
        || servers.len() != usize::from(tools)
        || servers.iter().any(|server| {
            server.get("name").and_then(Value::as_str) != Some("xcb")
                || server.get("status").and_then(Value::as_str) != Some("connected")
        })
    {
        return Err(Error::Protocol("effective runtime boundary mismatch"));
    }
    Ok(())
}

pub fn parse_quotas(value: &Value, pool: &Id, now: u64) -> Result<Vec<QuotaPoint>> {
    if value.get("rate_limits_available").and_then(Value::as_bool) != Some(true) {
        return Ok(vec![]);
    }
    let limits = value
        .get("rate_limits")
        .and_then(Value::as_object)
        .ok_or(Error::Protocol("quota windows"))?;
    let mut points = Vec::new();
    for name in [
        "five_hour",
        "seven_day",
        "seven_day_oauth_apps",
        "seven_day_opus",
        "seven_day_sonnet",
    ] {
        let Some(window) = limits.get(name).filter(|window| !window.is_null()) else {
            continue;
        };
        let Some(percent) = window.get("utilization").filter(|value| !value.is_null()) else {
            continue;
        };
        let percent = percent
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
            .ok_or(Error::Protocol("quota percentage"))?;
        let Some(reset) = window.get("resets_at").and_then(Value::as_str) else {
            continue;
        };
        let date =
            time::OffsetDateTime::parse(reset, &time::format_description::well_known::Rfc3339)
                .map_err(|_| Error::Protocol("quota reset timestamp"))?;
        let reset = u64::try_from(date.unix_timestamp_nanos() / 1_000_000)
            .map_err(|_| Error::Protocol("quota reset timestamp"))?;
        if reset <= now {
            continue;
        }
        points.push(QuotaPoint {
            pool: pool.clone(),
            window: Id::new(name)?,
            used_percent: percent,
            observed_at_ms: now,
            resets_at_ms: reset,
        });
    }
    Ok(points)
}

async fn handshake(
    process: &mut StreamProcess,
    tools: bool,
    system: &str,
) -> Result<Vec<ModelChoice>> {
    process.send(&initialize(tools, system)).await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        for _ in 0..256 {
            let frame = process
                .frame()
                .await?
                .ok_or(Error::Protocol("provider ended during initialization"))?;
            match claude::parse_event(&frame)? {
                Event::Control(envelope) => {
                    let request = envelope
                        .get("request")
                        .ok_or(Error::Protocol("control request"))?;
                    if request.get("subtype").and_then(Value::as_str) != Some("mcp_message") {
                        return Err(Error::Protocol("unexpected initialization request"));
                    }
                    let response = mcp_reply(request, tools, None)?;
                    control(process, &envelope, response).await?;
                }
                Event::ControlResponse(value)
                    if value
                        .pointer("/response/request_id")
                        .and_then(Value::as_str)
                        == Some("xcb_initialize") =>
                {
                    if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success")
                    {
                        return Err(Error::Protocol("initialization failed"));
                    }
                    return parse_models(
                        value
                            .pointer("/response/response")
                            .ok_or(Error::Protocol("initialize response"))?,
                        now_ms(),
                    );
                }
                Event::Notice => (),
                _ => return Err(Error::Protocol("unexpected frame before initialization")),
            }
        }
        Err(Error::Protocol("initialization frame limit"))
    })
    .await
    .map_err(|_| Error::Unavailable("provider initialization timed out"))?
}

pub async fn probe(store: &Store, pin: &Pin, account: Option<&Id>) -> Result<Vec<ModelChoice>> {
    let now = now_ms();
    let model = ModelChoice {
        provider: Provider::Claude,
        id: Id::new("claude-fable-5-1")?,
        label: "Fable 5.1".into(),
        mode: Mode::Fixed,
        resolved: None,
        effort: None,
        observed_at_ms: now,
    };
    let token = account.map(|id| auth::token(store, id)).transpose()?;
    let mut launch = prepare(
        pin,
        store.root(),
        &model,
        token.as_deref().map(|token| token.as_str()),
        false,
    )
    .await?;
    let bridge = launch.bridge.take();
    let run = account
        .map(|id| store.prepare_probe(id, Some(model.clone()), now))
        .transpose()?;
    let mut process = match StreamProcess::spawn(launch.command) {
        Ok(process) => process,
        Err(error) => {
            if let Some(run) = &run {
                store.settle(run, State::Failed, now_ms())?;
            }
            return Err(error);
        }
    };
    let result = async {
        if let Some(run) = &run { store.mark_spawned(run, process.pid())?; }
        let models = handshake(&mut process, false, "Return no messages; this connection is for host metadata queries only.").await?;
        if let Some(account) = account {
            process.send(&json!({"type":"control_request","request_id":"xcb_usage","request":{"subtype":"get_usage","skip_behaviors":true}})).await?;
            let response = tokio::time::timeout(Duration::from_secs(20), async {
                for _ in 0..128 {
                    let bytes = process.frame().await?.ok_or(Error::Protocol("usage connection ended"))?;
                    if let Event::ControlResponse(value) = claude::parse_event(&bytes)?
                        && value.pointer("/response/request_id").and_then(Value::as_str) == Some("xcb_usage") {
                            if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") { return Err(Error::Protocol("quota query unavailable")); }
                            return value.pointer("/response/response").cloned().ok_or(Error::Protocol("quota response"));
                        }
                }
                Err(Error::Protocol("usage frame limit"))
            }).await.map_err(|_| Error::Unavailable("usage query timed out"))??;
            for point in parse_quotas(&response, &store.account(account)?.quota_pool, now_ms())? { store.record_quota(&point)?; }
        }
        Ok::<_, Error>(models)
    }.await;
    let joined = process.join().await;
    if let Some(bridge) = bridge {
        let _ = bridge.close().await;
    }
    if !joined {
        return Err(Error::Unavailable(
            "metadata process stop is unproven; account custody retained",
        ));
    }
    if let Some(run) = &run {
        store.settle(run, State::Idle, now_ms())?;
    }
    result
}

pub struct RunInput {
    pub session: Session,
    pub message: Message,
    pub config: Config,
    pub pane_generation: bool,
}

pub async fn run(
    store: Arc<Store>,
    input: RunInput,
    mut cancel: watch::Receiver<bool>,
    observer: Observer,
) -> Result<Outcome> {
    let session = &input.session;
    if session.model.provider != Provider::Claude {
        return Err(Error::Unavailable(
            "native Codex and Devin execution are not yet qualified; catalog support does not activate them",
        ));
    }
    if *cancel.borrow() {
        return Err(Error::Unavailable("cancelled before launch"));
    }
    let pin = Pin::load(store.root(), Provider::Claude)?;
    let credential = auth::token(&store, &session.account)?;
    let tools = !input.pane_generation;
    let mut launch = prepare(&pin, store.root(), &session.model, Some(&credential), tools).await?;
    let bridge = launch.bridge.take();
    let workspace = Workspace::open(Path::new(&session.workspace))?;
    let run = store.prepare_run(&session.id, session.revision, now_ms())?;
    let mut process = match StreamProcess::spawn(launch.command) {
        Ok(process) => process,
        Err(error) => {
            store.settle(&run, State::Failed, now_ms())?;
            return Err(error);
        }
    };
    let mut effects = EffectState::None;
    let mut pending_attention = false;
    let mut quota_failure = None;
    let mut final_text = String::new();
    let mut thinking = String::new();
    let baseline = store
        .velocities(&session.id, 0)?
        .last()
        .map(|point| point.output_tokens)
        .unwrap_or(0);
    let execution = async {
        store.mark_spawned(&run, process.pid())?;
        let models = handshake(&mut process, tools, "You are xcb (Excalibur), a local coding assistant. Only the declared workspace tools can affect the project. There is no shell or arbitrary path access. Keep file revisions and use expectedRevision when writing. Never claim effects you did not perform. Ask for human input when it is necessary.").await?;
        if !models.iter().any(|choice| {
            choice.id == session.model.id
                && (session.model.effort.is_none() || choice.effort == session.model.effort)
        }) {
            return Err(Error::Unavailable(
                "selected model or effort is not in the fresh provider catalog",
            ));
        }
        store.set_models(Provider::Claude, &models)?;
        let history = store
            .messages(&session.id, 512)?
            .into_iter()
            .filter(|message| message.id != input.message.id)
            .collect::<Vec<_>>();
        let context_judge = if input.pane_generation {
            None
        } else {
            match judge::resolve(store.root(), &input.config.extensions.judge) {
                Ok(judge) => judge,
                Err(error) => {
                    observer(Progress::Notice(format!(
                        "Judge compaction unavailable ({error}); using deterministic Gobstopper"
                    )));
                    None
                }
            }
        };
        let projection = match context::project(
            session,
            &history,
            &input.message.text,
            &input.config.extensions.gobstopper,
            context_judge.as_deref(),
        )
        .await
        {
            Ok(projection) => projection,
            Err(error) if context_judge.is_some() => {
                observer(Progress::Notice(format!(
                    "Judge compaction unavailable ({error}); using deterministic Gobstopper"
                )));
                context::project(
                    session,
                    &history,
                    &input.message.text,
                    &input.config.extensions.gobstopper,
                    None,
                )
                .await?
            }
            Err(error) => return Err(error),
        };
        if projection.elided > 0 {
            observer(Progress::Notice(format!(
                "Gobstopper elided {} stale tool outputs in the prompt; history is retained.",
                projection.elided
            )));
        }
        let text = if input.pane_generation {
            input.message.text.clone()
        } else {
            context::prompt(&projection.messages, &input.message.text)?
        };
        let mut content = vec![json!({"type":"text","text":text})];
        for image in &input.message.attachments {
            let bytes = attachments::read(store.root(), image)?;
            content.push(json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
        }
        process.send(&json!({"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":content}})).await?;
        let started = now_ms();
        if input.config.extensions.usage {
            store.record_velocity(
                &session.id,
                VelocitySample {
                    at_ms: started,
                    output_tokens: baseline,
                },
            )?;
        }
        let mut admitted = false;
        let mut seen_calls = BTreeSet::new();
        let mut byte_count = 0usize;
        let mut completed_output = 0u64;
        let mut current_output = 0u64;
        // Velocity is a display meter; the authoritative usage lands via
        // record_usage at settle. Per-delta fsync'd transactions would
        // serialize every parallel terminal on one writer, so stream samples
        // are decimated and the true total is written once at the result.
        let mut last_velocity_ms = started;
        for _ in 0..16_384 {
            if *cancel.borrow() {
                return Ok((Terminal::Cancelled, vec![]));
            }
            let frame = tokio::select! {
                _ = cancel.changed() => return Ok((Terminal::Cancelled, vec![])),
                frame = process.frame() => frame?,
            }
            .ok_or(Error::Protocol("provider ended without a terminal result"))?;
            byte_count += frame.len();
            if byte_count > 16 * 1024 * 1024 {
                return Err(Error::Protocol("total provider output limit"));
            }
            let raw: Value = serde_json::from_slice(&frame)?;
            if input.config.extensions.usage && admitted {
                match raw.pointer("/event/type").and_then(Value::as_str) {
                    Some("message_start") => {
                        completed_output = completed_output.saturating_add(current_output);
                        current_output = 0;
                    }
                    Some("message_delta") => {
                        if let Some(total) = raw.pointer("/event/usage/output_tokens") {
                            let total = total
                                .as_u64()
                                .filter(|total| {
                                    *total >= current_output
                                        && *total <= xcb_core::usage::COUNTER_LIMIT
                                })
                                .ok_or(Error::Protocol("stream token counter"))?;
                            current_output = total;
                            let now = now_ms();
                            if now.saturating_sub(last_velocity_ms) >= 250 {
                                last_velocity_ms = now;
                                store.record_velocity(
                                    &session.id,
                                    VelocitySample {
                                        at_ms: now,
                                        output_tokens: baseline
                                            .saturating_add(completed_output)
                                            .saturating_add(current_output),
                                    },
                                )?;
                            }
                        }
                    }
                    _ => (),
                }
            }
            match claude::parse_event(&frame)? {
                Event::Initialize(value) => {
                    if admitted {
                        return Err(Error::Protocol("duplicate initialization"));
                    }
                    validate_init(&value, &launch.cwd, &session.model, tools)?;
                    admitted = true;
                }
                Event::Delta {
                    thinking: is_thinking,
                    text,
                } if admitted => {
                    if is_thinking {
                        if thinking.len() + text.len() > MAX_TEXT_BYTES {
                            return Err(Error::Protocol("thinking limit"));
                        }
                        thinking.push_str(&text);
                    }
                    observer(Progress::Text {
                        thinking: is_thinking,
                        text,
                    });
                }
                Event::Assistant { text, .. } if admitted => {
                    final_text = text;
                }
                Event::Quota {
                    window,
                    utilization,
                    resets_at_ms,
                    failure,
                } if admitted => {
                    quota_failure = failure;
                    if let (Some(window), Some(used), Some(reset)) =
                        (window, utilization, resets_at_ms)
                    {
                        let point = QuotaPoint {
                            pool: store.account(&session.account)?.quota_pool,
                            window: Id::new(window)?,
                            used_percent: used * 100.0,
                            observed_at_ms: now_ms(),
                            resets_at_ms: reset,
                        };
                        if point.validate().is_ok() {
                            store.record_quota(&point)?;
                        }
                    }
                }
                Event::Control(envelope) => {
                    let request = envelope
                        .get("request")
                        .ok_or(Error::Protocol("control request"))?;
                    if request.get("subtype").and_then(Value::as_str) == Some("can_use_tool") {
                        pending_attention = true;
                        control(&mut process, &envelope, json!({"behavior":"deny","message":"xcb will not manufacture permission; human attention is required"})).await?;
                        continue;
                    }
                    if request.get("subtype").and_then(Value::as_str) != Some("mcp_message") {
                        return Err(Error::Protocol("unhandled provider control request"));
                    }
                    let call = request.pointer("/message/method").and_then(Value::as_str)
                        == Some("tools/call");
                    let result = if call {
                        if !admitted || !tools || seen_calls.len() >= 128 {
                            return Err(Error::Protocol("tool call outside admitted turn"));
                        }
                        let call_id = envelope
                            .get("request_id")
                            .and_then(Value::as_str)
                            .ok_or(Error::Protocol("tool call identity"))?;
                        if !seen_calls.insert(call_id.to_owned()) {
                            return Err(Error::Protocol("duplicate tool call"));
                        }
                        let name = request
                            .pointer("/message/params/name")
                            .and_then(Value::as_str)
                            .ok_or(Error::Protocol("tool name"))?;
                        let arguments = request
                            .pointer("/message/params/arguments")
                            .ok_or(Error::Protocol("tool arguments"))?;
                        store.begin_tool(
                            &run,
                            call_id,
                            name,
                            &digest(serde_json::to_vec(arguments)?),
                        )?;
                        observer(Progress::Tool(name.to_owned()));
                        let output = workspace.call(name, arguments);
                        if output.is_ok() || name != "workspace_write" {
                            store.settle_tool(&run, call_id)?;
                        } else {
                            effects = EffectState::Uncertain;
                        }
                        if name == "workspace_write"
                            && output.is_ok()
                            && effects != EffectState::Uncertain
                        {
                            effects = EffectState::Settled;
                        }
                        let (text, failed) = match output {
                            Ok(output) => (serde_json::to_string(&output)?, false),
                            Err(error) => (error.to_string(), true),
                        };
                        if text.len() > MAX_TEXT_BYTES {
                            return Err(Error::Protocol("tool result limit"));
                        }
                        let current = store
                            .session(&session.id)?
                            .ok_or(Error::Unavailable("session not found"))?;
                        store.append_message(
                            &session.id,
                            current.revision,
                            &Message {
                                id: new_id("tool"),
                                role: Role::Tool,
                                text: format!("{name}: {text}"),
                                at_ms: now_ms(),
                                attachments: vec![],
                                provenance: Some(MessageProvenance {
                                    account: session.account.clone(),
                                    model: session.model.clone(),
                                    run: Some(run.id.clone()),
                                }),
                            },
                        )?;
                        Some(json!({"content":[{"type":"text","text":text}],"isError":failed}))
                    } else {
                        None
                    };
                    let response = mcp_reply(request, tools, result)?;
                    control(&mut process, &envelope, response).await?;
                }
                Event::Result {
                    terminal,
                    text,
                    models,
                } if admitted => {
                    if !text.is_empty() {
                        final_text = text;
                    }
                    if input.config.extensions.usage {
                        store.record_velocity(
                            &session.id,
                            VelocitySample {
                                at_ms: now_ms(),
                                output_tokens: baseline
                                    .saturating_add(completed_output)
                                    .saturating_add(current_output),
                            },
                        )?;
                    }
                    return Ok((terminal, models));
                }
                Event::Subagent {
                    id,
                    status,
                    label,
                    model,
                } if admitted => observer(Progress::Subagent(Subagent {
                    id: Id::new(id)?,
                    label,
                    state: match status.as_str() {
                        "working" | "running" => State::Working,
                        "completed" => State::Idle,
                        "failed" => State::Failed,
                        _ => State::Uncertain,
                    },
                    model,
                })),
                Event::Notice | Event::ControlResponse(_) => (),
                _ => {
                    return Err(Error::Protocol(
                        "provider work before effective-boundary admission",
                    ));
                }
            }
        }
        Err(Error::Protocol("provider frame count limit"))
    };
    let result = tokio::time::timeout(
        Duration::from_millis(
            input
                .config
                .extensions
                .auto_continue
                .max_elapsed_ms
                .min(300_000),
        ),
        execution,
    )
    .await;
    let joined = process.join().await;
    if let Some(bridge) = bridge {
        let _ = bridge.close().await;
    }
    let (terminal, models, failure) = match result {
        Ok(Ok((terminal, models))) => (
            terminal,
            models,
            if terminal == Terminal::Failed {
                quota_failure.or(Some(Failure::Unknown))
            } else {
                None
            },
        ),
        Ok(Err(error)) => {
            observer(Progress::Notice(error.to_string()));
            (Terminal::Failed, vec![], Some(Failure::Unknown))
        }
        Err(_) => {
            observer(Progress::Notice("Provider deadline reached".into()));
            (Terminal::Failed, vec![], Some(Failure::Transport))
        }
    };
    let mut facts = TurnFacts {
        terminal,
        joined,
        effects,
        pending_attention,
        failure,
    };
    let state = classify(&final_text, &facts);
    facts.pending_attention |= state.attention();
    if joined {
        if !thinking.is_empty() {
            let current = store
                .session(&session.id)?
                .ok_or(Error::Unavailable("session not found"))?;
            store.append_message(
                &session.id,
                current.revision,
                &Message {
                    id: new_id("thinking"),
                    role: Role::Thinking,
                    text: thinking,
                    at_ms: now_ms(),
                    attachments: vec![],
                    provenance: Some(MessageProvenance {
                        account: session.account.clone(),
                        model: session.model.clone(),
                        run: Some(run.id.clone()),
                    }),
                },
            )?;
        }
        if !final_text.is_empty() {
            let current = store
                .session(&session.id)?
                .ok_or(Error::Unavailable("session not found"))?;
            store.append_message(
                &session.id,
                current.revision,
                &Message {
                    id: new_id("assistant"),
                    role: Role::Assistant,
                    text: final_text.clone(),
                    at_ms: now_ms(),
                    attachments: vec![],
                    provenance: Some(MessageProvenance {
                        account: session.account.clone(),
                        model: session.model.clone(),
                        run: Some(run.id.clone()),
                    }),
                },
            )?;
        }
        if input.config.extensions.usage {
            for (index, (id, counters)) in models.into_iter().enumerate() {
                let model = ModelChoice {
                    id: Id::new(id.clone())?,
                    label: id,
                    ..session.model.clone()
                };
                store.record_usage(&UsageObservation {
                    id: Id::new(format!("{}_{index}", run.id))?,
                    session: session.id.clone(),
                    account: session.account.clone(),
                    model,
                    counters,
                    at_ms: now_ms(),
                })?;
            }
        }
        if effects != EffectState::Uncertain {
            store.settle(&run, state, now_ms())?;
        }
    }
    Ok(Outcome {
        text: final_text,
        facts,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn file(path: &Path, mode: u32) {
        let mut created = std::fs::File::create(path).unwrap();
        created.write_all(b"artifact").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Regression test for the Linux launch-plan seam: `prepare` builds its
    /// spec through `linux_spec`, and the sandbox planner must accept the
    /// plan it produces. The old spec double-mounted the executable and the
    /// forwarder runtime, which the planner rejected with "bind target
    /// duplicated" — every launch failed before bwrap even ran.
    #[test]
    fn linux_launch_plan_is_accepted_by_the_planner() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let directory = base.join("run");
        let scratch = directory.join("scratch");
        let cwd = scratch.join("work");
        let socket_dir = directory.join("egress");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&socket_dir).unwrap();
        let executable = base.join("provider");
        file(&executable, 0o500);
        let runtime = base.join("xcb");
        file(&runtime, 0o500);
        let socket = socket_dir.join("egress.sock");
        file(&socket, 0o600);
        let env_file = scratch.join("forwarder.env");
        file(&env_file, 0o600);
        let lib = base.join("libprovider.so");
        file(&lib, 0o400);
        let wrapper = base.join("bwrap");
        file(&wrapper, 0o755);
        let pin = sandbox::BwrapPin::admit(&wrapper).unwrap();

        let spec = linux_spec(
            executable.clone(),
            runtime.clone(),
            scratch.clone(),
            directory.join("sandbox.json"),
            socket.clone(),
            env_file.clone(),
            vec![lib.clone()],
        );
        let launch = sandbox::bwrap_launch(
            &pin,
            &spec,
            &["--print".into()],
            &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            &cwd,
        )
        .expect("the runner's launch plan must be accepted by the planner");

        // Every artifact is mounted exactly once — no duplicated targets.
        let policy: serde_json::Value = serde_json::from_str(&launch.policy).unwrap();
        let binds = policy["binds"].as_array().unwrap();
        for path in [&executable, &runtime, &lib, &scratch, &socket] {
            let path = path.to_str().unwrap();
            assert_eq!(
                binds.iter().filter(|bind| bind["target"] == path).count(),
                1,
                "{path} should appear as exactly one bind pair"
            );
        }
        // The env file rides the scratch bind and reaches the forwarder argv.
        let tail = &launch.args[launch.args.iter().position(|a| a == "--").unwrap() + 1..];
        assert_eq!(
            tail,
            [
                runtime.to_str().unwrap(),
                "egress-forward",
                socket.to_str().unwrap(),
                "48123",
                "-",
                env_file.to_str().unwrap(),
                "--",
                executable.to_str().unwrap(),
                "--print",
            ]
        );
        assert_eq!(policy["egress"]["protocol"], "connect-tcp443");
    }
}
