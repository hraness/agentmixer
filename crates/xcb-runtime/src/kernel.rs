use crate::{
    Error, Result, attachments, auth,
    config::Config,
    digest, hooks, new_id, now_ms, panes,
    process::Pin,
    runner::{self, Observer, Outcome, Progress, RunInput},
    store::Store,
    summary,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, SyncSender, TryRecvError},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use xcb_core::{
    Id, Provider,
    models::{ModelChoice, Preference},
    panes::Pane,
    policy::{RouteCandidate, Terminal, next_route, should_continue},
    session::{Message, Role, Session, State, Subagent},
    ui::{Intent, Update},
};

pub fn choose_model(
    store: &Store,
    provider: Provider,
    requested: Option<&str>,
    config: &Config,
) -> Result<ModelChoice> {
    let mut choices: Vec<_> = store
        .models()?
        .into_iter()
        .filter(|choice| choice.provider == provider)
        .collect();
    xcb_core::models::sort_choices(&mut choices, &config.favorites);
    if let Some(requested) = requested {
        let matches: Vec<_> = choices
            .into_iter()
            .filter(|choice| {
                choice.key() == requested
                    || choice.id.as_str() == requested
                    || choice.label == requested
            })
            .collect();
        return match matches.as_slice() {
            [choice] => Ok(choice.clone()),
            [] => Err(Error::Unavailable(
                "model not observed; refresh the catalog",
            )),
            _ => Err(Error::Unavailable(
                "model is ambiguous; use its full provider/model/effort key",
            )),
        };
    }
    choices.into_iter().next().ok_or(Error::Unavailable(
        "no observed models; run xcb models refresh for this provider",
    ))
}

pub fn new_session(
    store: &Store,
    workspace: &Path,
    config: &Config,
    account: Option<&Id>,
    model: Option<&str>,
) -> Result<Session> {
    let id = account
        .or(config.default_account.as_ref())
        .cloned()
        .or_else(|| {
            store
                .accounts()
                .ok()?
                .into_iter()
                .find(|account| account.enabled)
                .map(|account| account.id)
        })
        .ok_or(Error::Unavailable(
            "add an account with xcb accounts add, then sign in",
        ))?;
    let account = store.account(&id)?;
    let model = choose_model(store, account.provider, model, config)?;
    let session = store.create_session(&id, model, workspace, now_ms())?;
    store.select_pane(&session.id, &config.pane)?;
    store
        .session(&session.id)?
        .ok_or(Error::Unavailable("session not found"))
}

fn ready(store: &Store, session: &Session) -> Result<()> {
    if session.model.provider != Provider::Claude {
        return Err(Error::Unavailable(
            "native execution for this provider is still unqualified; catalog entries are not activation",
        ));
    }
    Pin::load(store.root(), session.model.provider)?;
    if !auth::has_token(store, &session.account)? {
        return Err(Error::Unavailable(
            "sign in with xcb accounts login before running a task",
        ));
    }
    if store
        .unsettled_runs()?
        .iter()
        .any(|run| run.account == session.account)
    {
        return Err(Error::Conflict("account has an unsettled run"));
    }
    Ok(())
}

async fn fire_hooks(
    store: &Store,
    config: &Config,
    event: hooks::Event,
    session: &Session,
    state: State,
    observer: &Observer,
) {
    if !config.extensions.hooks {
        return;
    }
    match hooks::fire(
        store.root(),
        event,
        &hooks::HookInput::new(event, session, state),
    )
    .await
    {
        Ok(notices) => notices
            .into_iter()
            .for_each(|notice| observer(Progress::Notice(notice))),
        Err(error) => observer(Progress::Notice(format!("Hook dispatch failed: {error}"))),
    }
}

pub async fn execute(
    store: Arc<Store>,
    session_id: Id,
    text: String,
    attachments: Vec<xcb_core::session::Attachment>,
    pane_generation: bool,
    cancel: watch::Receiver<bool>,
    observer: Observer,
) -> Result<Outcome> {
    let config = Config::load(store.root())?.0;
    let session = store
        .session(&session_id)?
        .ok_or(Error::Unavailable("session not found"))?;
    fire_hooks(
        &store,
        &config,
        hooks::Event::SessionStart,
        &session,
        session.state,
        &observer,
    )
    .await;
    let result = execute_inner(
        store.clone(),
        session_id.clone(),
        text,
        attachments,
        pane_generation,
        cancel,
        observer.clone(),
    )
    .await;
    if let Some(session) = store.session(&session_id)? {
        let config = Config::load(store.root())?.0;
        let state = result
            .as_ref()
            .map_or(State::Uncertain, |outcome| outcome.state);
        fire_hooks(
            &store,
            &config,
            hooks::Event::SessionEnd,
            &session,
            state,
            &observer,
        )
        .await;
    }
    result
}

async fn execute_inner(
    store: Arc<Store>,
    session_id: Id,
    text: String,
    attachments: Vec<xcb_core::session::Attachment>,
    pane_generation: bool,
    cancel: watch::Receiver<bool>,
    observer: Observer,
) -> Result<Outcome> {
    let started = now_ms();
    let mut consecutive = 0u32;
    let mut previous_output = None;
    let mut tried = BTreeSet::new();
    let mut text = text;
    let mut attachments = attachments;
    let mut role = Role::User;
    loop {
        if *cancel.borrow() {
            return Err(Error::Unavailable("cancelled before the next turn"));
        }
        let config = Config::load(store.root())?.0;
        let session = store
            .session(&session_id)?
            .ok_or(Error::Unavailable("session not found"))?;
        ready(&store, &session)?;
        tried.insert(format!("{}/{}", session.account, session.model.key()));
        let message = Message {
            id: new_id("m"),
            role,
            text,
            attachments,
            at_ms: now_ms(),
        };
        let current = store.append_message(&session_id, session.revision, &message)?;
        fire_hooks(
            &store,
            &config,
            hooks::Event::TurnStart,
            &current,
            State::Working,
            &observer,
        )
        .await;
        let result = runner::run(
            store.clone(),
            RunInput {
                session: current.clone(),
                message,
                config: config.clone(),
                pane_generation,
            },
            cancel.clone(),
            observer.clone(),
        )
        .await;
        let state = result
            .as_ref()
            .map_or(State::Uncertain, |outcome| outcome.state);
        fire_hooks(
            &store,
            &config,
            hooks::Event::TurnEnd,
            &current,
            state,
            &observer,
        )
        .await;
        let outcome = result?;
        if pane_generation || *cancel.borrow() {
            return Ok(outcome);
        }
        let current = store
            .session(&session_id)?
            .ok_or(Error::Unavailable("session not found"))?;
        if current.account != session.account || current.model.key() != session.model.key() {
            return Ok(outcome);
        }
        let current_config = Config::load(store.root())?.0;
        let output_digest = digest(&outcome.text);
        let repeat = previous_output.as_ref() == Some(&output_digest);
        if should_continue(
            &current_config.extensions.auto_continue,
            &outcome.facts,
            consecutive,
            now_ms().saturating_sub(started),
            repeat,
        ) {
            consecutive += 1;
            previous_output = Some(output_digest);
            observer(Progress::Notice(format!(
                "Auto-continue {consecutive}/{} · same task and permissions",
                current_config.extensions.auto_continue.max_consecutive
            )));
            text = "Continue the existing task from the last confirmed checkpoint. Do not repeat completed effects, expand the task, or answer for the user. Stop if approval or missing input is required.".into();
            attachments = vec![];
            role = Role::System;
            continue;
        }
        if current_config.auto_failover
            && now_ms().saturating_sub(started)
                < current_config.extensions.auto_continue.max_elapsed_ms
        {
            let view = summary::snapshot(&store, Some(&session_id), &current_config, now_ms())?;
            let source = RouteCandidate {
                account: current.account.clone(),
                model: current.model.clone(),
                admitted: true,
                quota_fresh: true,
                available: false,
            };
            let claude_admitted = Pin::load(store.root(), Provider::Claude).is_ok();
            let mut candidates = Vec::new();
            for model in &view.models {
                for account in &view.accounts {
                    if account.provider != model.provider
                        || account.busy
                        || !account.enabled
                        || candidates.len() >= 256
                    {
                        continue;
                    }
                    candidates.push(RouteCandidate {
                        account: account.id.clone(),
                        model: model.clone(),
                        admitted: model.provider == Provider::Claude && claude_admitted,
                        quota_fresh: account.remaining_percent.is_some(),
                        available: account
                            .remaining_percent
                            .is_some_and(|remaining| remaining > 0.0),
                    });
                }
            }
            if let Some(target) = next_route(
                &source,
                &candidates,
                &tried,
                &outcome.facts,
                !outcome.text.is_empty()
                    || outcome.facts.effects == xcb_core::policy::EffectState::None,
            ) {
                store.rebind(
                    &session_id,
                    current.revision,
                    &target.account,
                    target.model.clone(),
                )?;
                observer(Progress::Notice(format!(
                    "Usage limit: continuing the checkpoint on {} · {}",
                    target.model.provider, target.model.label
                )));
                text = "The prior provider reached a usage limit. Continue from the confirmed conversation and current workspace. Check current files before changing them; do not blindly replay prior operations. Stay within the existing task and ask for missing information.".into();
                attachments = vec![];
                role = Role::System;
                continue;
            }
        }
        return Ok(outcome);
    }
}

#[derive(Default)]
struct Activity {
    tools: Vec<String>,
    subagents: BTreeMap<Id, Subagent>,
}
struct Active {
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
    activity: Arc<Mutex<Activity>>,
    pane: bool,
}

fn publish(
    store: &Store,
    current: Option<&Id>,
    config: &Config,
    active: &BTreeMap<Id, Active>,
    output: &SyncSender<Update>,
) -> Result<()> {
    let mut view = summary::snapshot(store, current, config, now_ms())?;
    if let Some(active) = current.and_then(|id| active.get(id)) {
        view.state = State::Working;
        if let Ok(activity) = active.activity.lock() {
            view.activity = activity.tools.clone();
            view.subagents = activity.subagents.values().cloned().collect();
        }
    } else if view.state == State::Working {
        view.state = State::Uncertain;
    }
    let _ = output.try_send(Update::View(Box::new(view)));
    Ok(())
}

fn start(
    store: Arc<Store>,
    id: Id,
    text: String,
    attachments: Vec<xcb_core::session::Attachment>,
    pane: bool,
    output: SyncSender<Update>,
    finished: mpsc::Sender<(Id, Result<Outcome>)>,
) -> Active {
    let (cancel, cancelled) = watch::channel(false);
    let activity = Arc::new(Mutex::new(Activity::default()));
    let activity_copy = activity.clone();
    let session_id = id.clone();
    let observer: Observer = Arc::new(move |event| match event {
        Progress::Text { thinking, text } if !pane => {
            let _ = output.try_send(Update::Delta {
                session: session_id.clone(),
                thinking,
                text,
            });
        }
        Progress::Tool(name) => {
            if let Ok(mut activity) = activity_copy.lock() {
                if activity.tools.len() >= 128 {
                    activity.tools.remove(0);
                }
                activity.tools.push(name);
            }
        }
        Progress::Subagent(mut agent) => {
            if let Ok(mut activity) = activity_copy.lock()
                && (activity.subagents.len() < 64 || activity.subagents.contains_key(&agent.id))
            {
                if let Some(previous) = activity.subagents.get(&agent.id) {
                    if agent.label == "Subagent" {
                        agent.label.clone_from(&previous.label);
                    }
                    if agent.model.is_none() {
                        agent.model.clone_from(&previous.model);
                    }
                }
                activity.subagents.insert(agent.id.clone(), agent);
            }
        }
        Progress::Notice(message) => {
            let _ = output.try_send(Update::Notice(message));
        }
        _ => (),
    });
    let task = tokio::spawn(async move {
        let result = execute(
            store,
            id.clone(),
            text,
            attachments,
            pane,
            cancelled,
            observer,
        )
        .await;
        let _ = finished.send((id, result)).await;
    });
    Active {
        cancel,
        task,
        activity,
        pane,
    }
}

pub async fn serve(
    store: Arc<Store>,
    workspace: PathBuf,
    mut current: Option<Id>,
    input: Receiver<Intent>,
    output: SyncSender<Update>,
) -> Result<()> {
    let mut config = Config::load(store.root())?.0;
    let mut active: BTreeMap<Id, Active> = BTreeMap::new();
    let (completed, mut completions) = mpsc::channel::<(Id, Result<Outcome>)>(16);
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    let mut pending_pane: Option<(Id, String)> = None;
    let mut quit = false;
    publish(&store, current.as_ref(), &config, &active, &output)?;
    loop {
        tokio::select! {
            done = completions.recv() => if let Some((id, result)) = done {
                let was_pane = active.remove(&id).is_some_and(|active| active.pane);
                let _ = output.try_send(Update::ClearStream(id.clone()));
                match result {
                    Ok(outcome) if was_pane && outcome.facts.terminal == Terminal::Completed => {
                        let text = outcome.text.trim().strip_prefix("```json").or_else(|| outcome.text.trim().strip_prefix("```" )).unwrap_or(outcome.text.trim()).trim().trim_end_matches("```").trim();
                        match Pane::parse(text.as_bytes()) { Ok(pane) => { let _ = output.try_send(Update::PaneCandidate(pane)); } Err(error) => { let _ = output.try_send(Update::Notice(format!("Generated pane rejected: {error}. The current pane is unchanged."))); } }
                    }
                    Ok(outcome) if outcome.facts.terminal != Terminal::Completed => { let _ = output.try_send(Update::Notice(format!("Turn stopped: {}", outcome.state.label()))); }
                    Err(error) => { let _ = output.try_send(Update::Notice(error.to_string())); }
                    _ => (),
                }
                if let Some((queued_id, request)) = pending_pane.take()
                    && !quit { let session = store.session(&queued_id)?.ok_or(Error::Unavailable("session not found"))?; let generated = generation_session(&store, &session, &config)?; let task = start(store.clone(), generated.id.clone(), pane_prompt(&request)?, vec![], true, output.clone(), completed.clone()); active.insert(generated.id, task); }
                publish(&store, current.as_ref(), &config, &active, &output)?;
            },
            _ = ticker.tick() => {
                for _ in 0..16 {
                    let intent = match input.try_recv() { Ok(intent) => intent, Err(TryRecvError::Empty) => break, Err(TryRecvError::Disconnected) => Intent::Quit };
                    if matches!(intent, Intent::Quit) { quit = true; pending_pane = None; for task in active.values() { let _ = task.cancel.send(true); } break; }
                    let handled: Result<()> = (|| {
                        match intent {
                            Intent::Refresh => { match Config::load(store.root()) { Ok((fresh, _)) => config = fresh, Err(error) => { let _ = output.try_send(Update::Notice(format!("Configuration reload rejected: {error}"))); } } }
                            Intent::Submit { text, attachments } => {
                                if current.is_none() { current = Some(new_session(&store, &workspace, &config, None, None)?.id); }
                                let id = current.clone().expect("selected session");
                                if active.contains_key(&id) || active.len() >= 16 { return Err(Error::Conflict("a turn is still running; draft remains in prompt history")); }
                                let session = store.session(&id)?.ok_or(Error::Unavailable("session not found"))?;
                                ready(&store, &session)?;
                                active.insert(id.clone(), start(store.clone(), id, text, attachments, false, output.clone(), completed.clone()));
                            }
                            Intent::Cancel => { pending_pane = None; if let Some(task) = current.as_ref().and_then(|id| active.get(id)) { let _ = task.cancel.send(true); } }
                            Intent::Resume(id) => { if store.session(&id)?.is_none() { return Err(Error::Unavailable("session not found")); } current = Some(id); }
                            Intent::NewSession => current = Some(new_session(&store, &workspace, &config, None, None)?.id),
                            Intent::Account(account) => {
                                if current.as_ref().is_some_and(|id| active.contains_key(id)) { return Err(Error::Conflict("stop or finish the turn before changing accounts")); }
                                let provider = store.account(&account)?.provider;
                                let model = choose_model(&store, provider, None, &config)?;
                                if let Some(id) = &current { let session = store.session(id)?.ok_or(Error::Unavailable("session not found"))?; store.rebind(id, session.revision, &account, model)?; }
                                else { current = Some(new_session(&store, &workspace, &config, Some(&account), None)?.id); }
                            }
                            Intent::Model(key) => {
                                let matches: Vec<_> = store.models()?.into_iter().filter(|model| model.key() == key || model.id.as_str() == key).collect();
                                if matches.len() != 1 { return Err(Error::Unavailable("choose one exact observed model and effort")); }
                                let model = matches[0].clone();
                                if current.as_ref().is_some_and(|id| active.contains_key(id)) { return Err(Error::Conflict("finish the turn before changing models")); }
                                let account = current.as_ref().and_then(|id| store.session(id).ok().flatten()).filter(|session| session.model.provider == model.provider).map(|session| session.account)
                                    .or_else(|| store.accounts().ok()?.into_iter().find(|account| account.enabled && account.provider == model.provider).map(|account| account.id)).ok_or(Error::Unavailable("add an account for this provider"))?;
                                if let Some(id) = &current { let session = store.session(id)?.ok_or(Error::Unavailable("session not found"))?; store.rebind(id, session.revision, &account, model)?; }
                                else { current = Some(new_session(&store, &workspace, &config, Some(&account), Some(&model.key()))?.id); }
                            }
                            Intent::SetDefault => {
                                let session = current.as_ref().and_then(|id| store.session(id).ok().flatten()).ok_or(Error::Unavailable("select a session first"))?;
                                let (mut fresh, revision) = Config::load(store.root())?;
                                fresh.default_account = Some(session.account);
                                fresh.favorites.retain(|favorite| favorite.provider != session.model.provider || favorite.model != session.model.id || favorite.effort != session.model.effort);
                                fresh.favorites.insert(0, Preference { provider: session.model.provider, model: session.model.id, effort: session.model.effort });
                                fresh.save(store.root(), revision.as_deref())?; config = fresh;
                            }
                            Intent::Pane(id) => { panes::load(store.root(), &id)?; if let Some(session) = &current { store.select_pane(session, &id)?; } else { let (mut fresh, revision) = Config::load(store.root())?; fresh.pane = id; fresh.save(store.root(), revision.as_deref())?; config = fresh; } }
                            Intent::SavePane { pane, expected } => { panes::save(store.root(), &pane, expected.as_deref())?; if let Some(session) = &current { store.select_pane(session, &pane.id)?; } else { let (mut fresh, revision) = Config::load(store.root())?; fresh.pane = pane.id; fresh.save(store.root(), revision.as_deref())?; config = fresh; } }
                            Intent::GeneratePane(request) => {
                                let session = current.as_ref().and_then(|id| store.session(id).ok().flatten()).ok_or(Error::Unavailable("select an account and session before generating a pane"))?;
                                if active.values().any(|task| task.pane) || active.len() >= 16 { return Err(Error::Conflict("pane generation is already running")); }
                                if active.contains_key(&session.id) { pending_pane = Some((session.id, request)); let _ = output.try_send(Update::Notice("Pane generation queued for the account's next idle boundary. Editing and hot reload remain available.".into())); }
                                else { let generated = generation_session(&store, &session, &config)?; let task = start(store.clone(), generated.id.clone(), pane_prompt(&request)?, vec![], true, output.clone(), completed.clone()); active.insert(generated.id, task); }
                            }
                            Intent::AttachPath(path) => { let image = attachments::from_path(store.root(), Path::new(&path))?; let _ = output.try_send(Update::Attachment(image)); }
                            Intent::AttachRgba { width, height, bytes } => { let image = attachments::from_rgba(store.root(), width, height, bytes)?; let _ = output.try_send(Update::Attachment(image)); }
                            Intent::Extension { name, enabled } => {
                                let (mut fresh, revision) = Config::load(store.root())?;
                                match name.as_str() { "auto-continue" => fresh.extensions.auto_continue.enabled = enabled, "gobstopper" => fresh.extensions.gobstopper.enabled = enabled, "usage" => fresh.extensions.usage = enabled, "hooks" => fresh.extensions.hooks = enabled, "aicharts" | "aicharts-upload" => return Err(Error::Unavailable("automatic posting awaits a supported enrolled aiCharts ingress; local exports remain available")), _ => return Err(Error::Unavailable("unknown built-in extension")) }
                                fresh.save(store.root(), revision.as_deref())?; config = fresh;
                            }
                            Intent::Quit => (),
                        }
                        Ok(())
                    })();
                    if let Err(error) = handled { let _ = output.try_send(Update::Notice(error.to_string())); }
                    publish(&store, current.as_ref(), &config, &active, &output)?;
                }
            }
        }
        if quit && active.is_empty() {
            break;
        }
    }
    for (_, task) in active {
        let _ = task.cancel.send(true);
        let _ = task.task.await;
    }
    let _ = output.try_send(Update::Stopped);
    Ok(())
}

fn generation_session(store: &Store, source: &Session, config: &Config) -> Result<Session> {
    ready(store, source)?;
    new_session(
        store,
        Path::new(&source.workspace),
        config,
        Some(&source.account),
        Some(&source.model.key()),
    )
}
fn pane_prompt(request: &str) -> Result<String> {
    xcb_core::bounded_text(request, 4096)?;
    let preset = serde_json::to_string(&Pane::focus())?;
    Ok(format!(
        "Generate one xcb pane as JSON only. No markdown fences, code, commands, paths, or hooks. Schema: version 1, id (ASCII letters/digits/-/_), title, root. Nodes: column or row with 1..12 children; widget with source and optional lines (1..80); text with value; spacer with lines. Sources: last_user, responses, thinking, subagents, accounts, models, usage, activity, extensions. Maximum depth 8 and 96 nodes. Use a new id, never replace an existing preset. Example: {preset}\nUser's desired pane: {request}"
    ))
}
