use crate::{
    Error, Result, attachments, auth,
    config::Config,
    digest, exports, hooks, judge, new_id, now_ms, panes,
    process::Pin,
    runner::{self, Observer, Outcome, Progress, RunInput},
    store::Store,
    summary,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, SyncSender, TryRecvError, TrySendError},
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
    session::{Message, MessageProvenance, Role, Session, State, Subagent},
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

/// Picks an account/model route for `--model auto` through the judge: asks a
/// `choice` question over admitted, signable routes. Fails honestly when the
/// extension is off, no key is configured, or the judge rejects the batch —
/// `auto` never silently degrades to a deterministic pick, and an explicit
/// `--model` bypasses the judge entirely.
pub async fn auto_route(
    store: &Store,
    config: &Config,
    prompt: &str,
    account: Option<&Id>,
) -> Result<(Id, ModelChoice)> {
    let judge = judge::resolve(store.root(), &config.extensions.judge)?.ok_or(
        Error::Unavailable("--model auto needs the judge: xcb judge token && xcb judge enable"),
    )?;
    let view = summary::snapshot(store, None, config, now_ms())?;
    let claude_admitted = Pin::load(store.root(), Provider::Claude).is_ok();
    let mut candidates: Vec<(Id, ModelChoice)> = Vec::new();
    for model in &view.models {
        for view_account in &view.accounts {
            if view_account.provider != model.provider
                || view_account.busy
                || !view_account.enabled
                || account.is_some_and(|id| id != &view_account.id)
                || candidates.len() >= 16
            {
                continue;
            }
            let admitted = model.provider == Provider::Claude && claude_admitted;
            if !admitted || !auth::has_token(store, &view_account.id)? {
                continue;
            }
            candidates.push((view_account.id.clone(), model.clone()));
        }
    }
    pick_route(
        judge.as_ref(),
        "Choose the model route for a new coding task.",
        prompt,
        candidates,
    )
    .await
}

/// Asks the judge to pick one route out of the given candidates. Zero
/// candidates is an honest error; one skips the call entirely.
async fn pick_route(
    judge: &dyn judge::Judge,
    context: &str,
    task: &str,
    candidates: Vec<(Id, ModelChoice)>,
) -> Result<(Id, ModelChoice)> {
    if candidates.len() == 1 {
        return Ok(candidates.into_iter().next().expect("one candidate"));
    }
    if candidates.is_empty() || candidates.len() > 64 {
        return Err(Error::Unavailable(
            "no admitted routes; add an account and sign in",
        ));
    }
    let mut criteria = std::collections::BTreeMap::new();
    for (rank, (_, model)) in candidates.iter().enumerate() {
        criteria.insert(
            format!("route_{rank}"),
            Some(format!("{} · {}", model.provider, model.label)),
        );
    }
    let state = serde_json::json!({
        "context": context,
        "task": xcb_core::display_text(task, 8192),
    });
    let mut questions = judge::JudgeQuestions::new();
    questions.insert(
        "route".to_owned(),
        judge::JudgeQuestion::Choice {
            instructions: "Pick the route most likely to complete the task well.".to_owned(),
            criteria,
        },
    );
    let answers = judge.ask(&state, &questions).await?;
    let rank = answers
        .answers
        .get("route")
        .and_then(|answer| answer.choice())
        .and_then(|(pick, _)| {
            pick.strip_prefix("route_")
                .and_then(|rest| rest.parse::<usize>().ok())
        })
        .ok_or(Error::Unavailable("judge returned no route"))?;
    candidates
        .into_iter()
        .nth(rank)
        .ok_or(Error::Unavailable("judge route out of range"))
}

const JUDGE_CONTINUE_THRESHOLD: f64 = 0.7;

struct ContinuationInput<'a> {
    policy: &'a xcb_core::policy::AutoContinue,
    original_task: &'a str,
    last_response: &'a str,
    facts: &'a xcb_core::policy::TurnFacts,
    consecutive: u32,
    elapsed_ms: u64,
    repeated: bool,
}

async fn judge_continuation(
    judge: &dyn judge::Judge,
    input: ContinuationInput<'_>,
) -> Result<bool> {
    if !should_continue(
        input.policy,
        input.facts,
        input.consecutive,
        input.elapsed_ms,
        input.repeated,
    ) {
        return Ok(false);
    }
    let state = serde_json::json!({
        "context": "All deterministic continuation safety checks passed. Decide only whether the same task remains unfinished and can proceed without user input.",
        "original_task": xcb_core::display_text(input.original_task, 8192),
        "last_response": xcb_core::display_text(input.last_response, 8192),
        "turn": {
            "terminal": input.facts.terminal,
            "consecutive_continuations": input.consecutive,
            "elapsed_ms": input.elapsed_ms,
        },
    });
    let mut questions = judge::JudgeQuestions::new();
    questions.insert(
        "continue_task".to_owned(),
        judge::JudgeQuestion::Noul {
            instructions: "Should xcb automatically continue this exact coding task from the last confirmed checkpoint? Answer true only when the response plainly leaves unfinished work that can proceed without approval, clarification, missing input, repeated effects, or task expansion.".to_owned(),
            criteria: Some(judge::NoulCriteria {
                r#true: Some("The same task is clearly unfinished and safe to resume now.".to_owned()),
                r#false: Some("The task is complete, ambiguous, blocked, repetitive, or needs the user.".to_owned()),
            }),
        },
    );
    let answers = judge.ask(&state, &questions).await?;
    Ok(answers
        .answers
        .get("continue_task")
        .and_then(judge::JudgeAnswer::noul)
        .is_some_and(|probability| probability >= JUDGE_CONTINUE_THRESHOLD))
}

async fn configured_judge_continuation(
    root: &Path,
    config: &crate::config::JudgeConfig,
    input: ContinuationInput<'_>,
) -> Result<bool> {
    let judge = judge::resolve(root, config)?.ok_or(Error::Unavailable("judge key missing"))?;
    judge_continuation(judge.as_ref(), input).await
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
        if config.extensions.aicharts_export
            && config.extensions.usage
            && let Ok(ref outcome) = result
            && runner::should_idle_export(pane_generation, &outcome.facts, outcome.state)
            && let Err(error) = exports::export_session(&store, &session_id)
        {
            observer(Progress::Notice(format!(
                "aiCharts local idle export failed: {error}"
            )));
        }
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
    let original_task = text.clone();
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
            provenance: Some(MessageProvenance {
                account: session.account.clone(),
                model: session.model.clone(),
                run: None,
            }),
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
        let elapsed_ms = now_ms().saturating_sub(started);
        let deterministic_continue = should_continue(
            &current_config.extensions.auto_continue,
            &outcome.facts,
            consecutive,
            elapsed_ms,
            repeat,
        );
        let continue_turn = if deterministic_continue && current_config.extensions.judge.enabled {
            match configured_judge_continuation(
                store.root(),
                &current_config.extensions.judge,
                ContinuationInput {
                    policy: &current_config.extensions.auto_continue,
                    original_task: &original_task,
                    last_response: &outcome.text,
                    facts: &outcome.facts,
                    consecutive,
                    elapsed_ms,
                    repeated: repeat,
                },
            )
            .await
            {
                Ok(decision) => {
                    observer(Progress::Notice(
                        if decision {
                            "Judge advised continuing the same task"
                        } else {
                            "Judge stopped automatic continuation"
                        }
                        .to_owned(),
                    ));
                    decision
                }
                Err(error) => {
                    observer(Progress::Notice(format!(
                        "Judge continuation unavailable ({error}); stopping"
                    )));
                    false
                }
            }
        } else {
            deterministic_continue
        };
        if continue_turn {
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
            // Ask the judge to rank the routes `next_route` could pick; on any
            // failure — no key, unreadable vault, bad endpoint — the
            // deterministic order stands and the run keeps its contract.
            let failover_judge =
                match judge::resolve(store.root(), &current_config.extensions.judge) {
                    Ok(judge) => judge,
                    Err(error) => {
                        observer(Progress::Notice(format!(
                            "Judge unavailable ({error}); deterministic route order"
                        )));
                        None
                    }
                };
            if let Some(judge) = failover_judge {
                let eligible: Vec<usize> = candidates
                    .iter()
                    .enumerate()
                    .filter(|(_, candidate)| {
                        let key = format!("{}/{}", candidate.account, candidate.model.key());
                        candidate.admitted
                            && candidate.quota_fresh
                            && candidate.available
                            && !tried.contains(&key)
                            && !(candidate.account == source.account
                                && candidate.model == source.model)
                    })
                    .map(|(index, _)| index)
                    .take(16)
                    .collect();
                if eligible.len() > 1 {
                    let mut criteria = std::collections::BTreeMap::new();
                    for (rank, index) in eligible.iter().enumerate() {
                        let candidate = &candidates[*index];
                        criteria.insert(
                            format!("route_{rank}"),
                            Some(format!(
                                "{} · {} · {}",
                                candidate.model.provider, candidate.model.label, candidate.account
                            )),
                        );
                    }
                    let state = serde_json::json!({
                        "context": "A coding task lost its current route to a provider usage limit. Choose the best remaining route for the task; all listed routes are admitted and have quota.",
                        "task": xcb_core::display_text(&original_task, 8192),
                        "failure": format!("{:?}", outcome.facts.failure),
                    });
                    let mut questions = judge::JudgeQuestions::new();
                    questions.insert(
                        "route".to_owned(),
                        judge::JudgeQuestion::Choice {
                            instructions: "Pick the route most likely to complete the task well."
                                .to_owned(),
                            criteria,
                        },
                    );
                    match judge.ask(&state, &questions).await {
                        Ok(answers) => {
                            if let Some((pick, _)) = answers
                                .answers
                                .get("route")
                                .and_then(|answer| answer.choice())
                                && let Some(index) = pick
                                    .strip_prefix("route_")
                                    .and_then(|rest| rest.parse::<usize>().ok())
                                    .and_then(|rank| eligible.get(rank))
                            {
                                let chosen = candidates.remove(*index);
                                observer(Progress::Notice(
                                    "Judge selected an admitted failover route".to_owned(),
                                ));
                                candidates.insert(0, chosen);
                            }
                        }
                        Err(error) => observer(Progress::Notice(format!(
                            "Judge routing unavailable ({error}); deterministic order"
                        ))),
                    }
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

/// Updates queued for the terminal. `updates` is a guaranteed FIFO — notices,
/// state snapshots, and stream resets must arrive — while `deltas` coalesces
/// streamed text per session and stream kind so a burst can never drop part of
/// a response. A bounded channel can slow delivery, never corrupt it: the next
/// published `View` is always a full snapshot of the settled transcript.
#[derive(Default)]
struct Outbox {
    updates: VecDeque<Update>,
    deltas: BTreeMap<(Id, bool), String>,
}

/// Bound on queued guaranteed updates; the channel itself holds 256, so this
/// only engages when the display has stopped draining entirely.
const MAX_QUEUED_UPDATES: usize = 1024;

fn queue(outbox: &Mutex<Outbox>, update: Update) {
    let Ok(mut outbox) = outbox.lock() else {
        return;
    };
    if outbox.updates.len() >= MAX_QUEUED_UPDATES {
        // Prefer dropping the oldest buffered snapshot: every View is a full
        // snapshot, so an older one carries no unique information.
        if let Some(stale) = outbox
            .updates
            .iter()
            .position(|update| matches!(update, Update::View(_)))
        {
            outbox.updates.remove(stale);
        } else {
            outbox.updates.pop_front();
        }
    }
    outbox.updates.push_back(update);
}

fn flush(outbox: &Mutex<Outbox>, output: &SyncSender<Update>) {
    let Ok(mut outbox) = outbox.lock() else {
        return;
    };
    while let Some(update) = outbox.updates.pop_front() {
        match output.try_send(update) {
            Ok(()) => (),
            Err(TrySendError::Full(update)) => {
                outbox.updates.push_front(update);
                return;
            }
            Err(TrySendError::Disconnected(_)) => {
                outbox.updates.clear();
                outbox.deltas.clear();
                return;
            }
        }
    }
    for ((session, thinking), text) in outbox.deltas.iter_mut() {
        if text.is_empty() {
            continue;
        }
        let delta = Update::Delta {
            session: session.clone(),
            thinking: *thinking,
            text: std::mem::take(text),
        };
        match output.try_send(delta) {
            Ok(()) => (),
            Err(TrySendError::Full(Update::Delta { text: kept, .. }))
            | Err(TrySendError::Disconnected(Update::Delta { text: kept, .. })) => {
                *text = kept;
            }
            Err(_) => (),
        }
    }
    outbox.deltas.retain(|_, text| !text.is_empty());
}

fn publish(
    store: &Store,
    current: Option<&Id>,
    config: &Config,
    active: &BTreeMap<Id, Active>,
    outbox: &Mutex<Outbox>,
) -> Result<()> {
    let mut view = summary::snapshot(store, current, config, now_ms())?;
    if let Some(active) = current.and_then(|id| active.get(id)) {
        view.state = State::Working;
        if let Ok(activity) = active.activity.lock() {
            view.activity = activity.tools.clone();
            view.subagents = activity.subagents.values().cloned().collect();
        }
    } else if view.state == State::Working {
        // A session marked working without a task in this process may be owned
        // by a live sibling terminal; only an unowned run needs recovery.
        if let Some(id) = current {
            view.remote_active = store.remote_active(id)?;
        }
        if !view.remote_active {
            view.state = State::Uncertain;
        }
    }
    queue(outbox, Update::View(Box::new(view)));
    Ok(())
}

fn start(
    store: Arc<Store>,
    id: Id,
    text: String,
    attachments: Vec<xcb_core::session::Attachment>,
    pane: bool,
    outbox: Arc<Mutex<Outbox>>,
    finished: mpsc::Sender<(Id, Result<Outcome>)>,
) -> Active {
    let (cancel, cancelled) = watch::channel(false);
    let activity = Arc::new(Mutex::new(Activity::default()));
    let activity_copy = activity.clone();
    let session_id = id.clone();
    let observer: Observer = Arc::new(move |event| match event {
        Progress::Text { thinking, text } if !pane => {
            if let Ok(mut outbox) = outbox.lock() {
                let buffered = outbox
                    .deltas
                    .entry((session_id.clone(), thinking))
                    .or_default();
                let remaining = xcb_core::MAX_TEXT_BYTES.saturating_sub(buffered.len());
                buffered.push_str(&xcb_core::display_text(&text, remaining));
            }
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
        Progress::Notice(message) => queue(&outbox, Update::Notice(message)),
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
    let outbox = Arc::new(Mutex::new(Outbox::default()));
    let (completed, mut completions) = mpsc::channel::<(Id, Result<Outcome>)>(16);
    let mut ticker = tokio::time::interval(Duration::from_millis(20));
    let mut pending_pane: Option<(Id, String)> = None;
    let mut quit = false;
    publish(&store, current.as_ref(), &config, &active, &outbox)?;
    loop {
        flush(&outbox, &output);
        tokio::select! {
            done = completions.recv() => if let Some((id, result)) = done {
                let was_pane = active.remove(&id).is_some_and(|active| active.pane);
                if let Ok(mut queued) = outbox.lock() {
                    queued.deltas.retain(|(session, _), _| session != &id);
                }
                queue(&outbox, Update::ClearStream(id.clone()));
                match result {
                    Ok(outcome) if was_pane && outcome.facts.terminal == Terminal::Completed => {
                        let text = outcome.text.trim().strip_prefix("```json").or_else(|| outcome.text.trim().strip_prefix("```" )).unwrap_or(outcome.text.trim()).trim().trim_end_matches("```").trim();
                        match Pane::parse(text.as_bytes()) { Ok(pane) => queue(&outbox, Update::PaneCandidate(pane)), Err(error) => queue(&outbox, Update::Notice(format!("Generated pane rejected: {error}. The current pane is unchanged."))) }
                    }
                    Ok(outcome) if outcome.facts.terminal != Terminal::Completed => queue(&outbox, Update::Notice(format!("Turn stopped: {}", outcome.state.label()))),
                    Err(error) => queue(&outbox, Update::Notice(error.to_string())),
                    _ => (),
                }
                if let Some((queued_id, request)) = pending_pane.take()
                    && !quit { let session = store.session(&queued_id)?.ok_or(Error::Unavailable("session not found"))?; let generated = generation_session(&store, &session, &config)?; let task = start(store.clone(), generated.id.clone(), pane_prompt(&request)?, vec![], true, outbox.clone(), completed.clone()); active.insert(generated.id, task); }
                publish(&store, current.as_ref(), &config, &active, &outbox)?;
            },
            _ = ticker.tick() => {
                for _ in 0..16 {
                    let intent = match input.try_recv() { Ok(intent) => intent, Err(TryRecvError::Empty) => break, Err(TryRecvError::Disconnected) => Intent::Quit };
                    if matches!(intent, Intent::Quit) { quit = true; pending_pane = None; for task in active.values() { let _ = task.cancel.send(true); } break; }
                    let handled: Result<()> = (|| {
                        match intent {
                            Intent::Refresh => { match Config::load(store.root()) { Ok((fresh, _)) => config = fresh, Err(error) => queue(&outbox, Update::Notice(format!("Configuration reload rejected: {error}"))) } }
                            Intent::Submit { text, attachments } => {
                                let prepared: Result<Id> = (|| {
                                    if current.is_none() { current = Some(new_session(&store, &workspace, &config, None, None)?.id); }
                                    let id = current.clone().expect("selected session");
                                    if active.contains_key(&id) || active.len() >= 16 { return Err(Error::Conflict("a turn is still running; your draft was restored to the composer")); }
                                    let session = store.session(&id)?.ok_or(Error::Unavailable("session not found"))?;
                                    ready(&store, &session)?;
                                    Ok(id)
                                })();
                                match prepared {
                                    Ok(id) => { active.insert(id.clone(), start(store.clone(), id, text, attachments, false, outbox.clone(), completed.clone())); }
                                    Err(error) => {
                                        queue(&outbox, Update::Draft { text, attachments });
                                        return Err(error);
                                    }
                                }
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
                                if active.contains_key(&session.id) { pending_pane = Some((session.id, request)); queue(&outbox, Update::Notice("Pane generation queued for the account's next idle boundary. Editing and hot reload remain available.".into())); }
                                else { let generated = generation_session(&store, &session, &config)?; let task = start(store.clone(), generated.id.clone(), pane_prompt(&request)?, vec![], true, outbox.clone(), completed.clone()); active.insert(generated.id, task); }
                            }
                            Intent::AttachPath(path) => { let image = attachments::from_path(store.root(), Path::new(&path))?; queue(&outbox, Update::Attachment(image)); }
                            Intent::AttachRgba { width, height, bytes } => { let image = attachments::from_rgba(store.root(), width, height, bytes)?; queue(&outbox, Update::Attachment(image)); }
                            Intent::Extension { name, enabled } => {
                                let (mut fresh, revision) = Config::load(store.root())?;
                                match name.as_str() { "auto-continue" => fresh.extensions.auto_continue.enabled = enabled, "gobstopper" => fresh.extensions.gobstopper.enabled = enabled, "usage" => fresh.extensions.usage = enabled, "hooks" => fresh.extensions.hooks = enabled, "aicharts-export" => fresh.extensions.aicharts_export = enabled, "aicharts" | "aicharts-upload" => return Err(Error::Unavailable("automatic posting awaits a supported enrolled aiCharts ingress; local exports remain available")), _ => return Err(Error::Unavailable("unknown built-in extension")) }
                                fresh.save(store.root(), revision.as_deref())?; config = fresh;
                            }
                            Intent::Quit => (),
                        }
                        Ok(())
                    })();
                    if let Err(error) = handled { queue(&outbox, Update::Notice(error.to_string())); }
                    publish(&store, current.as_ref(), &config, &active, &outbox)?;
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
    queue(&outbox, Update::Stopped);
    flush(&outbox, &output);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::sync_channel;

    /// Saturating the bounded UI channel must never lose data: guaranteed
    /// updates arrive in order and coalesced stream text reassembles whole.
    #[test]
    fn a_saturated_channel_still_converges_on_the_full_update() {
        let (tx, rx) = sync_channel(4);
        let outbox = Mutex::new(Outbox::default());
        let session = new_id("s");
        for index in 0..10 {
            queue(&outbox, Update::Notice(format!("notice {index}")));
        }
        {
            let mut queued = outbox.lock().unwrap();
            let buffered = queued.deltas.entry((session.clone(), false)).or_default();
            buffered.push_str("first ");
            buffered.push_str("second");
        }

        let mut notices = Vec::new();
        let mut streamed = String::new();
        for _ in 0..128 {
            flush(&outbox, &tx);
            while let Ok(update) = rx.try_recv() {
                match update {
                    Update::Notice(text) => notices.push(text),
                    Update::Delta { text, .. } => streamed.push_str(&text),
                    _ => (),
                }
            }
            {
                let queued = outbox.lock().unwrap();
                if queued.updates.is_empty() && queued.deltas.is_empty() {
                    break;
                }
            }
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(
            notices,
            (0..10)
                .map(|index| format!("notice {index}"))
                .collect::<Vec<_>>(),
            "guaranteed updates arrive complete and in order"
        );
        assert_eq!(streamed, "first second");
    }

    /// Once the display is gone the queue must not grow without bound.
    #[test]
    fn a_disconnected_display_stops_queued_work() {
        let (tx, rx) = sync_channel(1);
        let outbox = Mutex::new(Outbox::default());
        queue(&outbox, Update::Notice("one".into()));
        flush(&outbox, &tx);
        queue(&outbox, Update::Notice("two".into()));
        drop(rx);
        flush(&outbox, &tx);
        let queued = outbox.lock().unwrap();
        assert!(queued.updates.is_empty());
    }

    struct PickJudge(String);
    impl judge::Judge for PickJudge {
        fn ask<'a>(
            &'a self,
            _state: &'a serde_json::Value,
            questions: &'a judge::JudgeQuestions,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<judge::JudgeAnswers>> + Send + 'a>,
        > {
            let pick = self.0.clone();
            let checked = questions.contains_key("route");
            Box::pin(async move {
                if !checked {
                    return Err(Error::Unavailable("missing route question"));
                }
                let mut answers = std::collections::BTreeMap::new();
                answers.insert(
                    "route".to_owned(),
                    judge::JudgeAnswer::Choice {
                        choice: pick,
                        confidence: 0.9,
                        probabilities: std::collections::BTreeMap::new(),
                    },
                );
                Ok(judge::JudgeAnswers {
                    answers,
                    model: None,
                })
            })
        }
    }

    struct ContinueJudge(f64);
    impl judge::Judge for ContinueJudge {
        fn ask<'a>(
            &'a self,
            state: &'a serde_json::Value,
            questions: &'a judge::JudgeQuestions,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<judge::JudgeAnswers>> + Send + 'a>,
        > {
            let probability = self.0;
            let checked = judge::check_state(state).is_ok()
                && judge::check_questions(questions).is_ok()
                && questions.contains_key("continue_task");
            Box::pin(async move {
                if !checked {
                    return Err(Error::Unavailable("invalid continuation question"));
                }
                let mut answers = std::collections::BTreeMap::new();
                answers.insert(
                    "continue_task".to_owned(),
                    judge::JudgeAnswer::Noul(probability),
                );
                Ok(judge::JudgeAnswers {
                    answers,
                    model: None,
                })
            })
        }
    }

    fn route_candidate(index: usize) -> (Id, ModelChoice) {
        (
            Id::new(format!("a{index}")).unwrap(),
            ModelChoice {
                provider: Provider::Claude,
                id: Id::new(format!("model-{index}")).unwrap(),
                label: format!("Model {index}"),
                mode: xcb_core::models::Mode::Fixed,
                resolved: None,
                effort: None,
                observed_at_ms: 1,
            },
        )
    }

    #[tokio::test]
    async fn pick_route_maps_the_choice_back_to_a_candidate() {
        let candidates = vec![route_candidate(0), route_candidate(1), route_candidate(2)];
        let (account, model) =
            pick_route(&PickJudge("route_1".to_owned()), "ctx", "task", candidates)
                .await
                .unwrap();
        assert_eq!(account.as_str(), "a1");
        assert_eq!(model.id.as_str(), "model-1");
    }

    #[tokio::test]
    async fn pick_route_skips_the_call_for_a_single_candidate() {
        let (account, _) = pick_route(
            &PickJudge("route_9".to_owned()),
            "ctx",
            "task",
            vec![route_candidate(0)],
        )
        .await
        .unwrap();
        assert_eq!(account.as_str(), "a0");
        assert!(
            pick_route(&PickJudge("route_0".into()), "ctx", "task", vec![])
                .await
                .is_err()
        );
        assert!(
            pick_route(
                &PickJudge("route_7".into()),
                "ctx",
                "task",
                vec![route_candidate(0), route_candidate(1)],
            )
            .await
            .is_err(),
            "out-of-range judge answers are rejected"
        );
    }

    #[tokio::test]
    async fn continuation_judgment_is_bounded_and_cannot_bypass_safety() {
        let policy = xcb_core::policy::AutoContinue::default();
        let facts = xcb_core::policy::TurnFacts {
            terminal: Terminal::TokenLimit,
            joined: true,
            effects: xcb_core::policy::EffectState::Settled,
            pending_attention: false,
            failure: None,
        };
        assert!(
            judge_continuation(
                &ContinueJudge(JUDGE_CONTINUE_THRESHOLD),
                ContinuationInput {
                    policy: &policy,
                    original_task: &"task".repeat(100_000),
                    last_response: &"response".repeat(100_000),
                    facts: &facts,
                    consecutive: 0,
                    elapsed_ms: 1_000,
                    repeated: false,
                },
            )
            .await
            .unwrap()
        );
        assert!(
            !judge_continuation(
                &ContinueJudge(JUDGE_CONTINUE_THRESHOLD - 0.01),
                ContinuationInput {
                    policy: &policy,
                    original_task: "task",
                    last_response: "response",
                    facts: &facts,
                    consecutive: 0,
                    elapsed_ms: 1_000,
                    repeated: false,
                },
            )
            .await
            .unwrap()
        );
        assert!(
            !judge_continuation(
                &ContinueJudge(1.0),
                ContinuationInput {
                    policy: &policy,
                    original_task: "task",
                    last_response: "response",
                    facts: &xcb_core::policy::TurnFacts {
                        pending_attention: true,
                        ..facts
                    },
                    consecutive: 0,
                    elapsed_ms: 1_000,
                    repeated: false,
                },
            )
            .await
            .unwrap()
        );
    }
}
