use crate::{Error, Result, attachments, auth, broker::{self, Workspace}, claude::{self, Event}, config::Config, context, digest, new_id, now_ms, private, process::{Pin, StreamProcess, environment}, sandbox, store::{RunRecord, Store, UsageObservation}};
use base64::Engine;
use serde_json::{Value, json};
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}, sync::Arc, time::Duration};
use tokio::{process::Command, sync::watch};
use xcb_core::{Id, Provider, MAX_TEXT_BYTES, models::{Mode, ModelChoice}, policy::{EffectState, Failure, Terminal, TurnFacts}, session::{Attachment, Message, Role, Session, State, Subagent, classify}, usage::{QuotaPoint, VelocitySample}};

pub enum Progress { Text { thinking: bool, text: String }, Tool(String), Subagent(Subagent), Notice(String) }
pub type Observer = Arc<dyn Fn(Progress) + Send + Sync>;
pub struct Outcome { pub text: String, pub facts: TurnFacts, pub state: State }

struct Launch { command: Command, cwd: PathBuf }

fn prepare(pin: &Pin, root: &Path, model: &ModelChoice, token: Option<&str>, tools: bool) -> Result<Launch> {
    if pin.provider != Provider::Claude || pin.version != claude::VERSION { return Err(Error::Unavailable("native execution requires the pinned Claude adapter; other providers remain unqualified")); }
    if !sandbox::available() { return Err(Error::Unavailable("native OS confinement is not qualified on this platform; no unsandboxed fallback")); }
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
    env.insert("CLAUDE_CONFIG_DIR".into(), config.to_string_lossy().into_owned());
    env.insert("TMPDIR".into(), tmp.to_string_lossy().into_owned());
    env.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into());
    env.insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into());
    if let Some(token) = token { env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), token.to_owned()); }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-f").arg(policy_path).arg(executable).args([
        "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--tools", "", "--permission-mode", "dontAsk", "--permission-prompt-tool", "stdio", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "32",
    ]);
    command.arg("--model").arg(model.id.as_str());
    if let Some(effort) = &model.effort { command.arg("--effort").arg(effort.as_str()); }
    command.arg("--settings").arg(json!({"disableAllHooks":true,"disableClaudeAiConnectors":true,"autoMemoryEnabled":false,"disableBundledSkills":true,"disableSkillShellExecution":true,"enableWorkflows":false,"workflowKeywordTriggerEnabled":false,"skillOverrides":{"doctor":"off","checkup":"off"}}).to_string());
    if tools { command.arg("--allowedTools").arg(broker::descriptors().iter().map(|tool| format!("mcp__xcb__{}", tool["name"].as_str().expect("tool name"))).collect::<Vec<_>>().join(",")); }
    command.env_clear().envs(env).current_dir(&cwd);
    Ok(Launch { command, cwd })
}

fn initialize(tools: bool, system: &str) -> Value {
    json!({"type":"control_request","request_id":"xcb_initialize","request":{"subtype":"initialize","sdkMcpServers":if tools { vec!["xcb"] } else { vec![] },"hooks":{},"agents":{},"skills":[],"plugins":[],"systemPrompt":[system],"supportedDialogKinds":[]}})
}

fn mcp_reply(request: &Value, tools: bool, call_result: Option<Value>) -> Result<Value> {
    if request.get("server_name").and_then(Value::as_str) != Some("xcb") || !tools { return Err(Error::Protocol("unexpected MCP server")); }
    let message = request.get("message").ok_or(Error::Protocol("MCP message"))?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") { return Err(Error::Protocol("MCP version")); }
    let result = match message.get("method").and_then(Value::as_str) {
        Some("initialize") => json!({"protocolVersion":message.pointer("/params/protocolVersion").and_then(Value::as_str).ok_or(Error::Protocol("MCP protocol"))?,"capabilities":{"tools":{}},"serverInfo":{"name":"xcb","version":env!("CARGO_PKG_VERSION")}}),
        Some("tools/list") => json!({"tools":broker::descriptors()}),
        Some("notifications/initialized") => return Ok(json!({})),
        Some("tools/call") => call_result.ok_or(Error::Protocol("tool call before admission"))?,
        _ => return Err(Error::Protocol("unsupported MCP method")),
    };
    let id = message.get("id").filter(|id| id.is_string() || id.is_i64()).ok_or(Error::Protocol("MCP request id"))?;
    Ok(json!({"mcp_response":{"jsonrpc":"2.0","id":id,"result":result}}))
}

async fn control(process: &mut StreamProcess, envelope: &Value, response: Value) -> Result<()> {
    let id = envelope.get("request_id").and_then(Value::as_str).filter(|id| id.len() <= 160).ok_or(Error::Protocol("control id"))?;
    process.send(&json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})).await
}

pub fn parse_models(value: &Value, now: u64) -> Result<Vec<ModelChoice>> {
    let models = value.get("models").and_then(Value::as_array).ok_or(Error::Protocol("model catalog"))?;
    if models.len() > 128 { return Err(Error::Protocol("model catalog limit")); }
    let mut choices = BTreeMap::new();
    for model in models {
        let id = Id::new(model.get("resolvedModel").or_else(|| model.get("value")).and_then(Value::as_str).ok_or(Error::Protocol("model identifier"))?)?;
        let name = model.get("displayName").and_then(Value::as_str).ok_or(Error::Protocol("model label"))?;
        xcb_core::label(name, 200)?;
        let efforts = match model.get("supportedEffortLevels") { None | Some(Value::Null) => vec![None], Some(value) => { let values = value.as_array().ok_or(Error::Protocol("model efforts"))?; if values.len() > 8 { return Err(Error::Protocol("effort limit")); } values.iter().map(|effort| Ok(Some(Id::new(effort.as_str().ok_or(Error::Protocol("effort value"))?)?))).collect::<Result<Vec<_>>>()? } };
        for effort in efforts {
            let choice = ModelChoice { provider: Provider::Claude, id: id.clone(), label: effort.as_ref().map(|effort| format!("{name} · {effort}")).unwrap_or_else(|| name.to_owned()), mode: Mode::Fixed, effort, observed_at_ms: now };
            choice.validate()?;
            choices.entry(choice.key()).or_insert(choice);
        }
    }
    Ok(choices.into_values().collect())
}

pub fn validate_init(value: &Value, cwd: &Path, model: &ModelChoice, tools: bool) -> Result<()> {
    let mut expected = if tools { broker::descriptors().iter().map(|tool| format!("mcp__xcb__{}", tool["name"].as_str().expect("static tool"))).collect::<Vec<_>>() } else { vec![] };
    expected.sort();
    let inventory = value.get("tools").and_then(Value::as_array).ok_or(Error::Protocol("tool inventory"))?;
    let mut actual = inventory.iter().map(|tool| tool.as_str().map(str::to_owned).ok_or(Error::Protocol("tool inventory name"))).collect::<Result<Vec<_>>>()?;
    actual.sort();
    let empty = |key: &str| value.get(key).and_then(Value::as_array).is_some_and(Vec::is_empty);
    let servers = value.get("mcp_servers").and_then(Value::as_array).ok_or(Error::Protocol("MCP inventory"))?;
    if value.get("claude_code_version").and_then(Value::as_str) != Some(claude::VERSION) || value.get("cwd").and_then(Value::as_str) != cwd.to_str() || value.get("model").and_then(Value::as_str) != Some(model.id.as_str()) || value.get("apiKeySource").and_then(Value::as_str) != Some("none") || value.get("permissionMode").and_then(Value::as_str) != Some("dontAsk") || actual != expected || !empty("skills") || !empty("plugins") || servers.len() != usize::from(tools) || servers.iter().any(|server| server.get("name").and_then(Value::as_str) != Some("xcb") || server.get("status").and_then(Value::as_str) != Some("connected")) {
        return Err(Error::Protocol("effective runtime boundary mismatch"));
    }
    Ok(())
}

pub fn parse_quotas(value: &Value, pool: &Id, now: u64) -> Result<Vec<QuotaPoint>> {
    if value.get("rate_limits_available").and_then(Value::as_bool) != Some(true) { return Ok(vec![]); }
    let limits = value.get("rate_limits").and_then(Value::as_object).ok_or(Error::Protocol("quota windows"))?;
    let mut points = Vec::new();
    for name in ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"] {
        let Some(window) = limits.get(name).filter(|window| !window.is_null()) else { continue; };
        let Some(percent) = window.get("utilization").filter(|value| !value.is_null()) else { continue; };
        let percent = percent.as_f64().filter(|value| value.is_finite() && (0.0..=100.0).contains(value)).ok_or(Error::Protocol("quota percentage"))?;
        let Some(reset) = window.get("resets_at").and_then(Value::as_str) else { continue; };
        let date = time::OffsetDateTime::parse(reset, &time::format_description::well_known::Rfc3339).map_err(|_| Error::Protocol("quota reset timestamp"))?;
        let reset = u64::try_from(date.unix_timestamp_nanos() / 1_000_000).map_err(|_| Error::Protocol("quota reset timestamp"))?;
        if reset <= now { continue; }
        points.push(QuotaPoint { pool: pool.clone(), window: Id::new(name)?, used_percent: percent, observed_at_ms: now, resets_at_ms: reset });
    }
    Ok(points)
}

async fn handshake(process: &mut StreamProcess, tools: bool, system: &str) -> Result<Vec<ModelChoice>> {
    process.send(&initialize(tools, system)).await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        for _ in 0..256 {
            let frame = process.frame().await?.ok_or(Error::Protocol("provider ended during initialization"))?;
            match claude::parse_event(&frame)? {
                Event::Control(envelope) => {
                    let request = envelope.get("request").ok_or(Error::Protocol("control request"))?;
                    if request.get("subtype").and_then(Value::as_str) != Some("mcp_message") { return Err(Error::Protocol("unexpected initialization request")); }
                    let response = mcp_reply(request, tools, None)?;
                    control(process, &envelope, response).await?;
                }
                Event::ControlResponse(value) if value.pointer("/response/request_id").and_then(Value::as_str) == Some("xcb_initialize") => {
                    if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") { return Err(Error::Protocol("initialization failed")); }
                    return parse_models(value.pointer("/response/response").ok_or(Error::Protocol("initialize response"))?, now_ms());
                }
                Event::Notice => (),
                _ => return Err(Error::Protocol("unexpected frame before initialization")),
            }
        }
        Err(Error::Protocol("initialization frame limit"))
    }).await.map_err(|_| Error::Unavailable("provider initialization timed out"))?
}

pub async fn probe(store: &Store, pin: &Pin, account: Option<&Id>) -> Result<Vec<ModelChoice>> {
    let model = ModelChoice { provider: Provider::Claude, id: Id::new("claude-fable-5-1")?, label: "Fable 5.1".into(), mode: Mode::Fixed, effort: None, observed_at_ms: 0 };
    let token = account.map(|id| auth::token(store, id)).transpose()?;
    let launch = prepare(pin, store.root(), &model, token.as_deref().map(|token| token.as_str()), false)?;
    let run = account.map(|id| store.prepare_probe(id, now_ms())).transpose()?;
    let mut process = match StreamProcess::spawn(launch.command) { Ok(process) => process, Err(error) => { if let Some(run) = &run { store.settle(run, State::Failed, now_ms())?; } return Err(error); } };
    let result = async {
        if let Some(run) = &run { store.mark_spawned(run, process.pid())?; }
        let models = handshake(&mut process, false, "Return no messages; this connection is for host metadata queries only.").await?;
        if let Some(account) = account {
            process.send(&json!({"type":"control_request","request_id":"xcb_usage","request":{"subtype":"get_usage","skip_behaviors":true}})).await?;
            let response = tokio::time::timeout(Duration::from_secs(20), async {
                for _ in 0..128 {
                    let bytes = process.frame().await?.ok_or(Error::Protocol("usage connection ended"))?;
                    if let Event::ControlResponse(value) = claude::parse_event(&bytes)? {
                        if value.pointer("/response/request_id").and_then(Value::as_str) == Some("xcb_usage") {
                            if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") { return Err(Error::Protocol("quota query unavailable")); }
                            return Ok(value.pointer("/response/response").cloned().ok_or(Error::Protocol("quota response"))?);
                        }
                    }
                }
                Err(Error::Protocol("usage frame limit"))
            }).await.map_err(|_| Error::Unavailable("usage query timed out"))??;
            for point in parse_quotas(&response, &store.account(account)?.quota_pool, now_ms())? { store.record_quota(&point)?; }
        }
        Ok::<_, Error>(models)
    }.await;
    let joined = process.join().await;
    if !joined { return Err(Error::Unavailable("metadata process stop is unproven; account custody retained")); }
    if let Some(run) = &run { store.settle(run, State::Idle, now_ms())?; }
    result
}

pub struct RunInput { pub session: Session, pub message: Message, pub config: Config, pub pane_generation: bool }

pub async fn run(store: Arc<Store>, input: RunInput, mut cancel: watch::Receiver<bool>, observer: Observer) -> Result<Outcome> {
    let session = &input.session;
    if session.model.provider != Provider::Claude { return Err(Error::Unavailable("native Codex and Devin execution are not yet qualified; catalog support does not activate them")); }
    if *cancel.borrow() { return Err(Error::Unavailable("cancelled before launch")); }
    let pin = Pin::load(store.root(), Provider::Claude)?;
    let credential = auth::token(&store, &session.account)?;
    let tools = !input.pane_generation;
    let launch = prepare(&pin, store.root(), &session.model, Some(&credential), tools)?;
    let workspace = Workspace::open(Path::new(&session.workspace))?;
    let run = store.prepare_run(&session.id, session.revision, now_ms())?;
    let mut process = match StreamProcess::spawn(launch.command) { Ok(process) => process, Err(error) => { store.settle(&run, State::Failed, now_ms())?; return Err(error); } };
    let mut effects = EffectState::None;
    let mut pending_attention = false;
    let mut quota_failure = None;
    let mut final_text = String::new();
    let mut thinking = String::new();
    let baseline = store.velocities(&session.id, 0)?.last().map(|point| point.output_tokens).unwrap_or(0);
    let execution = async {
        store.mark_spawned(&run, process.pid())?;
        let models = handshake(&mut process, tools, "You are xcb (Excalibur), a local coding assistant. Only the declared workspace tools can affect the project. There is no shell or arbitrary path access. Keep file revisions and use expectedRevision when writing. Never claim effects you did not perform. Ask for human input when it is necessary.").await?;
        if !models.iter().any(|choice| choice.id == session.model.id && (session.model.effort.is_none() || choice.effort == session.model.effort)) { return Err(Error::Unavailable("selected model or effort is not in the fresh provider catalog")); }
        store.set_models(Provider::Claude, &models)?;
        let history = store.messages(&session.id, 512)?.into_iter().filter(|message| message.id != input.message.id).collect::<Vec<_>>();
        let projection = context::project(session, &history, &input.config.extensions.gobstopper)?;
        if projection.elided > 0 { observer(Progress::Notice(format!("Gobstopper elided {} stale tool outputs in the prompt; history is retained.", projection.elided))); }
        let text = if input.pane_generation { input.message.text.clone() } else { context::prompt(&projection.messages, &input.message.text)? };
        let mut content = vec![json!({"type":"text","text":text})];
        for image in &input.message.attachments {
            let bytes = attachments::read(store.root(), image)?;
            content.push(json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
        }
        process.send(&json!({"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":content}})).await?;
        let started = now_ms();
        if input.config.extensions.usage { store.record_velocity(&session.id, VelocitySample { at_ms: started, output_tokens: baseline })?; }
        let mut admitted = false;
        let mut seen_calls = BTreeSet::new();
        let mut byte_count = 0usize;
        let mut completed_output = 0u64;
        let mut current_output = 0u64;
        for _ in 0..16_384 {
            if *cancel.borrow() { return Ok((Terminal::Cancelled, vec![])); }
            let frame = tokio::select! {
                _ = cancel.changed() => return Ok((Terminal::Cancelled, vec![])),
                frame = process.frame() => frame?,
            }.ok_or(Error::Protocol("provider ended without a terminal result"))?;
            byte_count += frame.len();
            if byte_count > 16 * 1024 * 1024 { return Err(Error::Protocol("total provider output limit")); }
            let raw: Value = serde_json::from_slice(&frame)?;
            if input.config.extensions.usage && admitted {
                match raw.pointer("/event/type").and_then(Value::as_str) {
                    Some("message_start") => { completed_output = completed_output.saturating_add(current_output); current_output = 0; }
                    Some("message_delta") => if let Some(total) = raw.pointer("/event/usage/output_tokens") {
                        let total = total.as_u64().filter(|total| *total >= current_output && *total <= xcb_core::usage::COUNTER_LIMIT).ok_or(Error::Protocol("stream token counter"))?;
                        current_output = total;
                        store.record_velocity(&session.id, VelocitySample { at_ms: now_ms(), output_tokens: baseline.saturating_add(completed_output).saturating_add(current_output) })?;
                    },
                    _ => (),
                }
            }
            match claude::parse_event(&frame)? {
                Event::Initialize(value) => { if admitted { return Err(Error::Protocol("duplicate initialization")); } validate_init(&value, &launch.cwd, &session.model, tools)?; admitted = true; }
                Event::Delta { thinking: is_thinking, text } if admitted => {
                    if is_thinking { if thinking.len() + text.len() > MAX_TEXT_BYTES { return Err(Error::Protocol("thinking limit")); } thinking.push_str(&text); }
                    observer(Progress::Text { thinking: is_thinking, text });
                }
                Event::Assistant { text, .. } if admitted => { final_text = text; }
                Event::Quota { window, utilization, resets_at_ms, failure } if admitted => {
                    quota_failure = failure;
                    if let (Some(window), Some(used), Some(reset)) = (window, utilization, resets_at_ms) {
                        let point = QuotaPoint { pool: store.account(&session.account)?.quota_pool, window: Id::new(window)?, used_percent: used * 100.0, observed_at_ms: now_ms(), resets_at_ms: reset };
                        if point.validate().is_ok() { store.record_quota(&point)?; }
                    }
                }
                Event::Control(envelope) => {
                    let request = envelope.get("request").ok_or(Error::Protocol("control request"))?;
                    if request.get("subtype").and_then(Value::as_str) == Some("can_use_tool") {
                        pending_attention = true;
                        control(&mut process, &envelope, json!({"behavior":"deny","message":"xcb will not manufacture permission; human attention is required"})).await?;
                        continue;
                    }
                    if request.get("subtype").and_then(Value::as_str) != Some("mcp_message") { return Err(Error::Protocol("unhandled provider control request")); }
                    let call = request.pointer("/message/method").and_then(Value::as_str) == Some("tools/call");
                    let result = if call {
                        if !admitted || !tools || seen_calls.len() >= 128 { return Err(Error::Protocol("tool call outside admitted turn")); }
                        let call_id = envelope.get("request_id").and_then(Value::as_str).ok_or(Error::Protocol("tool call identity"))?;
                        if !seen_calls.insert(call_id.to_owned()) { return Err(Error::Protocol("duplicate tool call")); }
                        let name = request.pointer("/message/params/name").and_then(Value::as_str).ok_or(Error::Protocol("tool name"))?;
                        let arguments = request.pointer("/message/params/arguments").ok_or(Error::Protocol("tool arguments"))?;
                        store.begin_tool(&run, call_id, name, &digest(serde_json::to_vec(arguments)?))?;
                        observer(Progress::Tool(name.to_owned()));
                        let output = workspace.call(name, arguments);
                        if output.is_ok() || name != "workspace_write" { store.settle_tool(&run, call_id)?; } else { effects = EffectState::Uncertain; }
                        if name == "workspace_write" && output.is_ok() && effects != EffectState::Uncertain { effects = EffectState::Settled; }
                        let (text, failed) = match output { Ok(output) => (serde_json::to_string(&output)?, false), Err(error) => (error.to_string(), true) };
                        if text.len() > MAX_TEXT_BYTES { return Err(Error::Protocol("tool result limit")); }
                        let current = store.session(&session.id)?.ok_or(Error::Unavailable("session not found"))?;
                        store.append_message(&session.id, current.revision, &Message { id: new_id("tool"), role: Role::Tool, text: format!("{name}: {text}"), at_ms: now_ms(), attachments: vec![] })?;
                        Some(json!({"content":[{"type":"text","text":text}],"isError":failed}))
                    } else { None };
                    let response = mcp_reply(request, tools, result)?;
                    control(&mut process, &envelope, response).await?;
                }
                Event::Result { terminal, text, models } if admitted => { if !text.is_empty() { final_text = text; } return Ok((terminal, models)); }
                Event::Subagent { id, status, label } if admitted => observer(Progress::Subagent(Subagent { id: Id::new(id)?, label, state: match status.as_str() { "working" | "running" => State::Working, "completed" => State::Idle, "failed" => State::Failed, _ => State::Uncertain }, model: None })),
                Event::Notice | Event::ControlResponse(_) => (),
                _ => return Err(Error::Protocol("provider work before effective-boundary admission")),
            }
        }
        Err(Error::Protocol("provider frame count limit"))
    };
    let result = tokio::time::timeout(Duration::from_millis(input.config.extensions.auto_continue.max_elapsed_ms.min(300_000)), execution).await;
    let joined = process.join().await;
    let (terminal, models, failure) = match result {
        Ok(Ok((terminal, models))) => (terminal, models, if terminal == Terminal::Failed { quota_failure.or(Some(Failure::Unknown)) } else { None }),
        Ok(Err(error)) => { observer(Progress::Notice(error.to_string())); (Terminal::Failed, vec![], Some(Failure::Unknown)) }
        Err(_) => { observer(Progress::Notice("Provider deadline reached".into())); (Terminal::Failed, vec![], Some(Failure::Transport)) }
    };
    let mut facts = TurnFacts { terminal, joined, effects, pending_attention, failure };
    let state = classify(&final_text, &facts);
    facts.pending_attention |= state.attention();
    if joined {
        if !thinking.is_empty() { let current = store.session(&session.id)?.ok_or(Error::Unavailable("session not found"))?; store.append_message(&session.id, current.revision, &Message { id: new_id("thinking"), role: Role::Thinking, text: thinking, at_ms: now_ms(), attachments: vec![] })?; }
        if !final_text.is_empty() { let current = store.session(&session.id)?.ok_or(Error::Unavailable("session not found"))?; store.append_message(&session.id, current.revision, &Message { id: new_id("assistant"), role: Role::Assistant, text: final_text.clone(), at_ms: now_ms(), attachments: vec![] })?; }
        if input.config.extensions.usage {
            for (index, (id, counters)) in models.into_iter().enumerate() {
                let model = ModelChoice { id: Id::new(id.clone())?, label: id, ..session.model.clone() };
                store.record_usage(&UsageObservation { id: Id::new(format!("{}_{index}", run.id))?, session: session.id.clone(), account: session.account.clone(), model, counters, at_ms: now_ms() })?;
            }
        }
        if effects != EffectState::Uncertain { store.settle(&run, state, now_ms())?; }
    }
    Ok(Outcome { text: final_text, facts, state })
}
