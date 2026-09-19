use clap::{CommandFactory, Parser, Subcommand};
use serde_json::json;
use std::{
    io::{self, IsTerminal, Read},
    path::PathBuf,
    sync::{Arc, mpsc::sync_channel},
};
use tokio::{process::Command, sync::watch};
use xcb_core::{
    Id, Provider,
    models::{Preference, parse_devin_catalog, sort_choices},
    panes::Pane,
    policy::Terminal,
};
use xcb_runtime::{
    Error, Result, auth,
    config::Config,
    exports, hooks, judge, kernel, now_ms, panes, private,
    process::{self, Pin},
    runner::{self, Observer, Progress},
    store::Store,
    summary,
};

#[derive(Parser)]
#[command(
    name = "xcb",
    version,
    about = "Excalibur — a local, composable terminal workspace for coding agents"
)]
struct Cli {
    #[arg(long, global = true)]
    state: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true, default_value = ".")]
    cwd: PathBuf,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    Chat,
    Run {
        #[arg(short = 'p', long)]
        prompt: Option<String>,
        #[arg(long)]
        account: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long = "image")]
        images: Vec<PathBuf>,
    },
    Resume {
        id: Option<Id>,
    },
    Accounts {
        #[command(subcommand)]
        command: Option<AccountCommand>,
    },
    Models {
        #[command(subcommand)]
        command: Option<ModelCommand>,
    },
    Sessions {
        #[command(subcommand)]
        command: Option<SessionCommand>,
    },
    Panes {
        #[command(subcommand)]
        command: Option<PaneCommand>,
    },
    Plugins {
        #[command(subcommand)]
        command: Option<PluginCommand>,
    },
    Hooks {
        #[command(subcommand)]
        command: Option<HookCommand>,
    },
    Judge {
        #[command(subcommand)]
        command: Option<JudgeCommand>,
    },
    Doctor {
        #[arg(long)]
        provider: Option<Provider>,
        #[arg(long)]
        executable: Option<PathBuf>,
    },
    Config,
    Recover {
        run: Option<Id>,
        #[arg(long)]
        yes: bool,
    },
    #[command(name = "egress-forward", hide = true)]
    EgressForward {
        socket: PathBuf,
        port: u16,
        lo_up: String,
        env_file: String,
        #[arg(long, default_value_t = 443)]
        target_port: u16,
        #[arg(last = true, required = true)]
        child: Vec<String>,
    },
    Completions {
        shell: clap_complete::Shell,
    },
}

#[derive(Subcommand)]
enum AccountCommand {
    Add {
        provider: Provider,
        label: String,
        #[arg(long, default_value = "Subscription")]
        plan: String,
    },
    Login {
        account: String,
    },
    Token {
        account: String,
    },
    Default {
        account: String,
    },
    Disable {
        account: String,
    },
    Enable {
        account: String,
    },
    Refresh {
        account: String,
    },
    ImportAgentmixer {
        #[arg(long)]
        source: PathBuf,
        #[arg(long, default_value = "AgentMixer account")]
        label: String,
    },
}
#[derive(Subcommand)]
enum ModelCommand {
    Refresh {
        provider: Provider,
        #[arg(long)]
        account: Option<String>,
        #[arg(long)]
        from_native: bool,
    },
    Default {
        key: String,
    },
}
#[derive(Subcommand)]
enum SessionCommand {
    Export,
    Rm {
        id: Id,
        #[arg(long)]
        yes: bool,
    },
    Prune {
        #[arg(default_value_t = 30, value_parser = clap::value_parser!(u16).range(1..=3650))]
        days: u16,
        #[arg(long)]
        yes: bool,
    },
}
#[derive(Subcommand)]
enum PaneCommand {
    Show {
        #[arg(default_value = "focus")]
        id: Id,
    },
    Check {
        path: PathBuf,
    },
    Install {
        path: PathBuf,
    },
}
#[derive(Subcommand)]
enum PluginCommand {
    Enable { name: String },
    Disable { name: String },
}
#[derive(Subcommand)]
enum JudgeCommand {
    /// Store a judge API key piped on stdin; never an argument or terminal echo.
    Token,
    /// Remove the vaulted judge key.
    Logout,
    /// Report judge configuration without revealing the key.
    Status,
    /// Allow judged routing, safe continuation advice, and Gobstopper vetoes.
    Enable,
    /// Disable judge use; routing, continuation, and compaction stay deterministic.
    Disable,
    /// Send one live noul question to verify the key and endpoint.
    Test,
}
#[derive(Subcommand)]
enum HookCommand {
    Add {
        event: String,
        executable: PathBuf,
        #[arg(long, default_value_t = 5_000)]
        timeout_ms: u64,
    },
    Enable {
        id: Id,
    },
    Disable {
        id: Id,
    },
}

fn stdin(max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io::stdin().take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(xcb_core::Error::Limit("stdin").into());
    }
    Ok(bytes)
}
fn print_json(value: impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn accounts(store: &Store, config: &Config, as_json: bool) -> Result<()> {
    let view = summary::snapshot(store, None, config, now_ms())?;
    if as_json {
        return print_json(
            json!({"version":1,"accounts":view.accounts.iter().map(|account| json!({"id":account.id,"label":account.label,"provider":account.provider,"subscription":account.subscription,"remainingPercent":account.remaining_percent,"resetsAtMs":account.resets_at_ms,"runway":account.runway,"busy":account.busy,"enabled":account.enabled})).collect::<Vec<_>>(),"estimatedPoolSeconds":view.total_runway_seconds,"measuredPools":view.runway_coverage.0,"totalPools":view.runway_coverage.1,"localOnly":true}),
        );
    }
    if view.accounts.is_empty() {
        println!(
            "No accounts yet.\n\nxcb accounts add claude personal --plan Max\nxcb doctor --provider claude\nxcb accounts login personal\nxcb accounts refresh personal"
        );
        return Ok(());
    }
    println!("  ACCOUNT             PROVIDER  PLAN              REMAINING    EST. RUNWAY");
    for account in view.accounts {
        let remaining = account
            .remaining_percent
            .map(|percent| format!("{percent:.0}%"))
            .unwrap_or_else(|| "unknown".into());
        let runway = account
            .runway
            .seconds()
            .map(|seconds| format!("~{:.1}h", seconds / 3600.0))
            .unwrap_or_else(|| "unmeasured".into());
        println!(
            "{} {:<19} {:<9} {:<17} {:<12} {}{}",
            if config.default_account.as_ref() == Some(&account.id) {
                ">"
            } else {
                " "
            },
            xcb_core::display_text(&account.label, 32),
            account.provider,
            xcb_core::display_text(&account.subscription, 24),
            remaining,
            runway,
            if account.busy { " · busy" } else { "" }
        );
    }
    if let Some(seconds) = view.total_runway_seconds {
        println!(
            "\nMeasured pool runway: ~{:.1}h ({}/{} pools; estimate, not a billing statement)",
            seconds / 3600.0,
            view.runway_coverage.0,
            view.runway_coverage.1
        );
    }
    Ok(())
}

/// `xcb egress-forward <socket> <port> <lo_up> <env_file> -- <child...>`:
/// "-" placeholders become absent paths; the forwarder supervises the child
/// with loopback CONNECT proxying through the host bridge socket.
async fn egress_forward(
    socket: &std::path::Path,
    port: u16,
    lo_up: &str,
    env_file: &str,
    target_port: u16,
    child: &[String],
) -> Result<i32> {
    let lo_up = (lo_up != "-").then(|| PathBuf::from(lo_up));
    let env_file = (env_file != "-").then(|| PathBuf::from(env_file));
    xcb_runtime::egress::run_forwarder(
        socket,
        port,
        target_port,
        lo_up.as_deref(),
        env_file.as_deref(),
        child,
    )
    .await
}

async fn dispatch(cli: Cli) -> Result<i32> {
    // The hidden in-namespace forwarder must not touch CLI state: inside the
    // bwrap plan the environment is --clearenv (no HOME/XCB_STATE) and the
    // host state root is unbound, so Store/Config init would fail before the
    // forwarder ever read its env file. It runs on its arguments alone.
    if let Some(Commands::EgressForward {
        socket,
        port,
        lo_up,
        env_file,
        target_port,
        child,
    }) = &cli.command
    {
        return egress_forward(socket, *port, lo_up, env_file, *target_port, child).await;
    }
    let root = cli.state.unwrap_or(private::default_root()?);
    let store = Arc::new(Store::open(&root)?);
    let (mut config, _) = Config::load(store.root())?;
    match cli.command {
        None | Some(Commands::Chat) => chat(store, cli.cwd.canonicalize()?, None, cli.json).await,
        Some(Commands::Resume { id }) => {
            let id = id
                .or_else(|| {
                    store
                        .sessions(1)
                        .ok()?
                        .first()
                        .map(|session| session.id.clone())
                })
                .ok_or(Error::Unavailable("no saved sessions"))?;
            let session = store
                .session(&id)?
                .ok_or(Error::Unavailable("session not found"))?;
            chat(store, PathBuf::from(session.workspace), Some(id), cli.json).await
        }
        Some(Commands::Run {
            prompt,
            account,
            model,
            images,
        }) => {
            let prompt = match prompt {
                Some(prompt) => prompt,
                None if !io::stdin().is_terminal() => {
                    String::from_utf8(stdin(xcb_core::MAX_TEXT_BYTES)?)
                        .map_err(|_| xcb_core::Error::Invalid("UTF-8 prompt"))?
                }
                None => {
                    return Err(Error::Unavailable(
                        "use xcb run -p <task> or pipe a task on stdin",
                    ));
                }
            };
            xcb_core::bounded_text(&prompt, xcb_core::MAX_TEXT_BYTES)?;
            if images.len() > 8 {
                return Err(xcb_core::Error::Limit("images").into());
            }
            let attachments = images
                .iter()
                .map(|path| xcb_runtime::attachments::from_path(store.root(), path))
                .collect::<Result<Vec<_>>>()?;
            let mut account = account
                .map(|name| store.resolve_account(&name).map(|account| account.id))
                .transpose()?;
            let mut model = model;
            if model.as_deref() == Some("auto") {
                let (routed_account, choice) =
                    kernel::auto_route(&store, &config, &prompt, account.as_ref()).await?;
                eprintln!("xcb: judge selected an admitted route");
                account = Some(routed_account);
                model = Some(choice.key());
            }
            let session = kernel::new_session(
                &store,
                &cli.cwd.canonicalize()?,
                &config,
                account.as_ref(),
                model.as_deref(),
            )?;
            let (cancel, cancelled) = watch::channel(false);
            let interrupt = tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                let _ = cancel.send(true);
            });
            let observer: Observer = Arc::new(|event| {
                if let Progress::Notice(message) = event {
                    eprintln!("xcb: {message}");
                }
            });
            let result = kernel::execute(
                store,
                session.id,
                prompt,
                attachments,
                false,
                cancelled,
                observer,
            )
            .await;
            interrupt.abort();
            let result = result?;
            if cli.json {
                print_json(
                    json!({"version":1,"state":result.state,"outcome":result.facts,"text":result.text}),
                )?;
            } else {
                println!("{}", result.text);
            }
            Ok(if result.facts.terminal == Terminal::Completed {
                0
            } else {
                1
            })
        }
        Some(Commands::Accounts { command }) => {
            match command {
                None => accounts(&store, &config, cli.json)?,
                Some(AccountCommand::Add {
                    provider,
                    label,
                    plan,
                }) => {
                    let account = store.add_account(provider, &label, &plan, now_ms())?;
                    let (mut config, revision) = Config::load(store.root())?;
                    if config.default_account.is_none() {
                        config.default_account = Some(account.id.clone());
                        config.save(store.root(), revision.as_deref())?;
                    }
                    if cli.json {
                        print_json(account)?;
                    } else {
                        println!(
                            "Added {} ({}) · {}\nNext: xcb accounts login {}",
                            account.label, account.provider, account.id, account.id
                        );
                    }
                }
                Some(AccountCommand::Login { account }) => {
                    let account = store.resolve_account(&account)?;
                    let pin = Pin::load(store.root(), account.provider)?;
                    eprintln!(
                        "Complete the provider's browser sign-in. Credential output is captured, not printed."
                    );
                    auth::login(&store, &account.id, &pin).await?;
                    if cli.json {
                        print_json(json!({"version":1,"account":account.id,"stored":true}))?;
                    } else {
                        println!(
                            "Sign-in completed for {}. Run xcb accounts refresh {} to read supported quota windows.",
                            account.label, account.id
                        );
                    }
                }
                Some(AccountCommand::Token { account }) => {
                    if io::stdin().is_terminal() {
                        return Err(Error::Unavailable(
                            "token input is accepted only through a pipe, never an argument or terminal echo",
                        ));
                    }
                    let account = store.resolve_account(&account)?;
                    let bytes = stdin(2048)?;
                    auth::store_token(&store, &account.id, &bytes)?;
                    println!("Credential stored for {}", account.label);
                }
                Some(AccountCommand::Default { account }) => {
                    let account = store.resolve_account(&account)?;
                    let (mut config, revision) = Config::load(store.root())?;
                    config.default_account = Some(account.id);
                    config.save(store.root(), revision.as_deref())?;
                }
                Some(AccountCommand::Disable { account }) => {
                    store.set_account_enabled(&store.resolve_account(&account)?.id, false)?
                }
                Some(AccountCommand::Enable { account }) => {
                    store.set_account_enabled(&store.resolve_account(&account)?.id, true)?
                }
                Some(AccountCommand::Refresh { account }) => {
                    let account = store.resolve_account(&account)?;
                    if account.provider != Provider::Claude {
                        return Err(Error::Unavailable(
                            "native account-quota querying for this provider is not yet qualified",
                        ));
                    }
                    let pin = Pin::load(store.root(), account.provider)?;
                    let models = runner::probe(&store, &pin, Some(&account.id)).await?;
                    store.set_models(account.provider, &models)?;
                    accounts(&store, &config, cli.json)?;
                }
                Some(AccountCommand::ImportAgentmixer { source, label }) => {
                    let id = auth::import_agentmixer_token(&store, &source, &label)?;
                    if cli.json {
                        print_json(
                            json!({"version":1,"account":id,"sourcePreserved":true,"sessionsMigrated":false}),
                        )?;
                    } else {
                        println!(
                            "Imported one Claude credential as {id}. Original state and sessions are unchanged."
                        );
                    }
                }
            }
            Ok(0)
        }
        Some(Commands::Doctor {
            provider,
            executable,
        }) => {
            if executable.is_some() && provider.is_none() {
                return Err(Error::Unavailable("--executable requires --provider"));
            }
            let home = private::directory(&root.join("metadata-home"))?;
            private::directory(&home.join("tmp"))?;
            let mut found = 0;
            let mut reports = vec![];
            for provider in
                provider.map_or_else(|| Provider::ALL.to_vec(), |provider| vec![provider])
            {
                match process::inspect(provider, executable.as_deref(), &home).await {
                    Ok(pin) => {
                        pin.save(&root)?;
                        let native = provider == Provider::Claude
                            && xcb_runtime::claude::version_admitted(&pin.version)
                            && xcb_runtime::sandbox::available();
                        let detail = if native {
                            "pinned · per-run boundary verification required"
                        } else {
                            "metadata pin only · native execution unavailable"
                        };
                        reports.push(json!({"provider":provider,"version":pin.version,"sha256":pin.sha256,"nativeCandidate":native,"detail":detail}));
                        if !cli.json {
                            println!("{provider}: {} · {detail}", pin.version);
                        }
                        found += 1;
                        if native {
                            match runner::probe(&store, &pin, None).await {
                                Ok(models) => store.set_models(provider, &models)?,
                                Err(error) => eprintln!("xcb: metadata probe: {error}"),
                            }
                        }
                    }
                    Err(error) => {
                        reports.push(json!({"provider":provider,"error":error.to_string()}));
                        if !cli.json {
                            println!("{provider}: {error}");
                        }
                    }
                }
            }
            let judge_key = judge::judge_token(store.root())?.map(|(_, source)| source);
            let judge_key_name = match judge_key {
                Some(judge::JudgeKeySource::Env) => "env",
                Some(judge::JudgeKeySource::Vault) => "vault",
                None => "none",
            };
            let (judge_model, judge_endpoint) =
                xcb_runtime::jev::effective_target(&config.extensions.judge);
            let judge_status = json!({
                "enabled": config.extensions.judge.enabled,
                "key": judge_key_name,
                "model": judge_model,
                "endpoint": judge_endpoint,
            });
            if cli.json {
                let mut report = json!({"version":1,"providers":reports,"unsettledRuns":store.unsettled_runs()?});
                report["judge"] = judge_status;
                if cfg!(target_os = "linux") {
                    let status = xcb_runtime::sandbox::linux_sandbox(&root);
                    report["sandbox"] = json!({"backend":"bwrap","candidate":status.candidate,"admitted":status.admitted,"unprivilegedUsernsClone":status.unprivileged_userns_clone,"maxUserNamespaces":status.max_user_namespaces,"qualified":status.qualified});
                }
                print_json(report)?;
            } else {
                if cfg!(target_os = "linux") {
                    let status = xcb_runtime::sandbox::linux_sandbox(&root);
                    let detail = match &status.candidate {
                        Some(path) if status.admitted => {
                            format!("bwrap candidate {} admitted", path.display())
                        }
                        Some(path) => {
                            format!("bwrap candidate {} fails admission", path.display())
                        }
                        None => "bwrap unavailable".to_owned(),
                    };
                    let userns =
                        match (status.unprivileged_userns_clone, status.max_user_namespaces) {
                            (Some(false), _) | (_, Some(0)) => " · user namespaces restricted",
                            _ => "",
                        };
                    let qual = if status.qualified {
                        "qualified"
                    } else {
                        "unqualified · place a current qualification receipt"
                    };
                    println!("sandbox: {detail}{userns} · {qual}");
                }
                println!(
                    "judge: {} · key {judge_key_name} · {judge_endpoint}",
                    if config.extensions.judge.enabled {
                        "enabled"
                    } else {
                        "disabled"
                    },
                );
                for run in store.unsettled_runs()? {
                    println!("Unsettled run {} · custody retained", run.id);
                }
            }
            Ok(if found > 0 { 0 } else { 1 })
        }
        Some(Commands::Models { command }) => {
            match command {
                Some(ModelCommand::Refresh {
                    provider,
                    account,
                    from_native,
                }) => {
                    let pin = Pin::load(store.root(), provider)?;
                    let models = match provider {
                        Provider::Claude => {
                            let account = account
                                .map(|name| store.resolve_account(&name).map(|account| account.id))
                                .transpose()?;
                            runner::probe(&store, &pin, account.as_ref()).await?
                        }
                        Provider::Devin => {
                            let home = if from_native {
                                PathBuf::from(std::env::var_os("HOME").ok_or(Error::PrivateState)?)
                                    .canonicalize()?
                            } else {
                                let account = store.resolve_account(account.as_deref().ok_or(Error::Unavailable("select --account or explicitly use --from-native for read-only catalog discovery"))?)?;
                                if account.provider != provider {
                                    return Err(Error::Conflict(
                                        "catalog account provider mismatch",
                                    ));
                                }
                                store.account_root(&account.id)?.join("home")
                            };
                            let mut command = Command::new(pin.executable);
                            command
                                .args(["models", "list", "--format", "json"])
                                .env_clear()
                                .envs(process::environment(&home))
                                .current_dir(&home);
                            parse_devin_catalog(
                                &process::capture(
                                    command,
                                    xcb_core::MAX_JSON_BYTES,
                                    std::time::Duration::from_secs(30),
                                )
                                .await?,
                                now_ms(),
                            )?
                        }
                        Provider::Codex => {
                            return Err(Error::Unavailable(
                                "native Codex catalog adapter is not yet qualified",
                            ));
                        }
                    };
                    store.set_models(provider, &models)?;
                }
                Some(ModelCommand::Default { key }) => {
                    let choice = store
                        .models()?
                        .into_iter()
                        .find(|model| model.key() == key)
                        .ok_or(Error::Unavailable("use the full observed model key"))?;
                    let (mut config, revision) = Config::load(store.root())?;
                    config.favorites.retain(|favorite| {
                        favorite.provider != choice.provider
                            || favorite.model != choice.id
                            || favorite.effort != choice.effort
                    });
                    config.favorites.insert(
                        0,
                        Preference {
                            provider: choice.provider,
                            model: choice.id,
                            effort: choice.effort,
                        },
                    );
                    config.save(store.root(), revision.as_deref())?;
                }
                None => (),
            }
            let mut choices = store.models()?;
            sort_choices(&mut choices, &Config::load(store.root())?.0.favorites);
            if cli.json {
                print_json(choices)?;
            } else {
                for choice in choices {
                    println!("{:<56} {} · {:?}", choice.key(), choice.label, choice.mode);
                }
            }
            Ok(0)
        }
        Some(Commands::Sessions { command }) => {
            match command {
                None => {
                    let sessions = store.sessions(64)?;
                    if cli.json {
                        print_json(sessions)?;
                    } else {
                        for session in sessions {
                            println!(
                                "{}  {}  {}  {}",
                                session.id,
                                session.model.provider,
                                session.model.label,
                                session.title
                            );
                        }
                    }
                }
                Some(SessionCommand::Export) => {
                    let path = exports::write(&store)?;
                    if cli.json {
                        print_json(
                            json!({"version":1,"profile":"session-observations-v1","path":path}),
                        )?;
                    } else {
                        println!(
                            "Exported local aiCharts session observations to {}",
                            path.display()
                        );
                    }
                }
                Some(SessionCommand::Rm { id, yes }) => {
                    if !yes {
                        println!(
                            "Would remove {id} and its transcript. Repeat with --yes to apply."
                        );
                    } else {
                        let removed = store.remove_session(&id)?;
                        if cli.json {
                            print_json(json!({"removed":removed}))?;
                        } else {
                            println!(
                                "{}",
                                if removed {
                                    "Session removed"
                                } else {
                                    "Session not found"
                                }
                            );
                        }
                    }
                }
                Some(SessionCommand::Prune { days, yes }) => {
                    let candidates = store.prune_candidates(
                        now_ms().saturating_sub(u64::from(days) * 86_400_000),
                        1000,
                    )?;
                    let count = candidates.len();
                    if yes {
                        for id in &candidates {
                            store.remove_session(id)?;
                        }
                    }
                    if cli.json {
                        print_json(
                            json!({"version":1,"applied":yes,"count":count,"sessions":candidates}),
                        )?;
                    } else {
                        println!(
                            "{} {count} idle session(s) older than {days} days. Active or unsettled sessions are excluded.{}",
                            if yes { "Pruned" } else { "Would prune" },
                            if yes {
                                ""
                            } else {
                                " Repeat with --yes to apply."
                            }
                        );
                    }
                }
            }
            Ok(0)
        }
        Some(Commands::Panes { command }) => {
            match command {
                None => {
                    let entries = panes::list(store.root())?;
                    if cli.json {
                        print_json(entries)?;
                    } else {
                        for pane in entries {
                            println!("{}  {}", pane.id, pane.title);
                        }
                    }
                }
                Some(PaneCommand::Show { id }) => print_json(panes::load(store.root(), &id)?.0)?,
                Some(PaneCommand::Check { path }) => {
                    let pane = Pane::parse(&std::fs::read(path)?)?;
                    print_json(json!({"valid":true,"id":pane.id}))?;
                }
                Some(PaneCommand::Install { path }) => {
                    let pane = Pane::parse(&std::fs::read(path)?)?;
                    panes::save(store.root(), &pane, None)?;
                    print_json(json!({"installed":pane.id,"executable":false}))?;
                }
            }
            Ok(0)
        }
        Some(Commands::Plugins { command }) => {
            if let Some(command) = command {
                let (name, enabled) = match command {
                    PluginCommand::Enable { name } => (name, true),
                    PluginCommand::Disable { name } => (name, false),
                };
                let (mut fresh, revision) = Config::load(store.root())?;
                match name.as_str() {
                    "auto-continue" => fresh.extensions.auto_continue.enabled = enabled,
                    "gobstopper" => fresh.extensions.gobstopper.enabled = enabled,
                    "usage" => fresh.extensions.usage = enabled,
                    "hooks" => fresh.extensions.hooks = enabled,
                    "aicharts-export" => fresh.extensions.aicharts_export = enabled,
                    "aicharts" | "aicharts-upload" => {
                        return Err(Error::Unavailable(
                            "automatic posting awaits a supported enrolled aiCharts ingress; local exports remain available",
                        ));
                    }
                    _ => return Err(Error::Unavailable("unknown or not-yet-available extension")),
                }
                fresh.save(store.root(), revision.as_deref())?;
                config = fresh;
            }
            print_json(&config.extensions)?;
            Ok(0)
        }
        Some(Commands::Hooks { command }) => {
            match command {
                None => print_json(hooks::list(store.root())?)?,
                Some(HookCommand::Add {
                    event,
                    executable,
                    timeout_ms,
                }) => {
                    let hook = hooks::add(store.root(), event.parse()?, &executable, timeout_ms)?;
                    print_json(
                        json!({"hook":hook,"enabled":false,"next":format!("xcb hooks enable {}", hook.id)}),
                    )?;
                }
                Some(HookCommand::Enable { id }) => {
                    print_json(hooks::set_enabled(store.root(), &id, true)?)?
                }
                Some(HookCommand::Disable { id }) => {
                    print_json(hooks::set_enabled(store.root(), &id, false)?)?
                }
            }
            Ok(0)
        }
        Some(Commands::Judge { command }) => {
            match command {
                Some(JudgeCommand::Token) => {
                    if io::stdin().is_terminal() {
                        return Err(Error::Unavailable(
                            "key input is accepted only through a pipe, never an argument or terminal echo",
                        ));
                    }
                    judge::store_judge_token(store.root(), &stdin(2048)?)?;
                    println!("Judge key stored.");
                }
                Some(JudgeCommand::Logout) => {
                    if judge::remove_judge_token(store.root())? {
                        println!("Judge key removed.");
                    } else {
                        println!("No vaulted judge key.");
                    }
                }
                Some(JudgeCommand::Enable) => {
                    let (mut fresh, revision) = Config::load(store.root())?;
                    fresh.extensions.judge.enabled = true;
                    fresh.save(store.root(), revision.as_deref())?;
                    println!("Judge enabled.");
                }
                Some(JudgeCommand::Disable) => {
                    let (mut fresh, revision) = Config::load(store.root())?;
                    fresh.extensions.judge.enabled = false;
                    fresh.save(store.root(), revision.as_deref())?;
                    println!("Judge disabled.");
                }
                Some(JudgeCommand::Test) => {
                    let backend = judge::resolve(store.root(), &config.extensions.judge)?.ok_or(
                        Error::Unavailable(
                            "judge not configured: store a key with xcb judge token and xcb judge enable",
                        ),
                    )?;
                    let mut questions = judge::JudgeQuestions::new();
                    questions.insert(
                        "ping".to_owned(),
                        judge::JudgeQuestion::Noul {
                            instructions: "Is the sky blue on a clear day?".to_owned(),
                            criteria: None,
                        },
                    );
                    questions.insert(
                        "pick".to_owned(),
                        judge::JudgeQuestion::Choice {
                            instructions: "Which option names a color?".to_owned(),
                            criteria: std::collections::BTreeMap::from([
                                ("red".to_owned(), Some("a color".to_owned())),
                                ("spoon".to_owned(), Some("not a color".to_owned())),
                            ]),
                        },
                    );
                    questions.insert(
                        "rate".to_owned(),
                        judge::JudgeQuestion::Score {
                            instructions: "How true is the claim that water is wet? Rate on the ordered criteria scale.".to_owned(),
                            criteria: vec![
                                "false".to_owned(),
                                "partly true".to_owned(),
                                "true".to_owned(),
                            ],
                        },
                    );
                    let answers = backend
                        .ask(
                            &serde_json::json!({"context": "xcb judge connectivity test"}),
                            &questions,
                        )
                        .await?;
                    let noul = answers
                        .answers
                        .get("ping")
                        .and_then(|a| a.noul())
                        .ok_or(Error::Unavailable("judge response missing noul answer"))?;
                    let (pick, pick_confidence) = answers
                        .answers
                        .get("pick")
                        .and_then(|a| a.choice())
                        .ok_or(Error::Unavailable("judge response missing choice answer"))?;
                    let (score, score_confidence) = answers
                        .answers
                        .get("rate")
                        .and_then(|a| a.score())
                        .ok_or(Error::Unavailable("judge response missing score answer"))?;
                    println!(
                        "Judge reachable · model {} · noul {noul:.3} · choice {pick}@{pick_confidence:.3} · score {score:.3}@{score_confidence:.3}",
                        answers.model.as_deref().unwrap_or("unknown")
                    );
                }
                None | Some(JudgeCommand::Status) => {
                    let source = judge::judge_token(store.root())?.map(|(_, source)| source);
                    let (judge_model, judge_endpoint) =
                        xcb_runtime::jev::effective_target(&config.extensions.judge);
                    if cli.json {
                        print_json(json!({
                            "version": 1,
                            "enabled": config.extensions.judge.enabled,
                            "key": match source {
                                Some(judge::JudgeKeySource::Env) => "env",
                                Some(judge::JudgeKeySource::Vault) => "vault",
                                None => "none",
                            },
                            "model": judge_model,
                            "endpoint": judge_endpoint,
                        }))?;
                    } else {
                        let key = match source {
                            Some(judge::JudgeKeySource::Env) => "env",
                            Some(judge::JudgeKeySource::Vault) => "vault",
                            None => "none",
                        };
                        println!(
                            "judge: {} · key {key} · model {judge_model} · {judge_endpoint}",
                            if config.extensions.judge.enabled {
                                "enabled"
                            } else {
                                "disabled"
                            },
                        );
                    }
                }
            }
            Ok(0)
        }
        Some(Commands::Config) => {
            print_json(config)?;
            Ok(0)
        }
        Some(Commands::Recover { run, yes }) => {
            if let Some(run_id) = run {
                let (run, run_digest) = store
                    .recovery_candidate(&run_id)?
                    .ok_or(Error::Unavailable("run not found"))?;
                let pid = run.pid.ok_or(Error::Conflict(
                    "run has no process group; recovery requires a running phase with a recorded pid",
                ))?;
                if run.phase != "running" {
                    return Err(Error::Conflict(
                        "run is not in running phase; recovery requires a recorded process group",
                    ));
                }
                if !yes {
                    if cli.json {
                        print_json(
                            json!({"version":1,"dryRun":true,"run":run.id,"phase":run.phase,"pid":pid}),
                        )?;
                    } else {
                        println!(
                            "Would recover run {} · phase {} · process group {}.\nRepeat with --yes after verifying the process group is absent.",
                            run.id, run.phase, pid
                        );
                    }
                    return Ok(0);
                }
                process::prove_process_group_absent(pid)?;
                let settled = store.recover_run(&run_id, &run_digest, now_ms())?;
                if cli.json {
                    print_json(
                        json!({"version":1,"recovered":settled.id,"phase":settled.phase,"pid":pid}),
                    )?;
                } else {
                    println!(
                        "Recovered run {} · process group {} confirmed absent",
                        settled.id, pid
                    );
                }
            } else {
                let runs = store.unsettled_runs()?;
                if cli.json {
                    print_json(
                        json!({"version":1,"runs":runs.iter().map(|run| json!({"id":run.id,"phase":run.phase,"pid":run.pid,"createdAtMs":run.created_at_ms})).collect::<Vec<_>>()}),
                    )?;
                } else if runs.is_empty() {
                    println!("No unsettled runs.");
                } else {
                    println!("Unsettled runs:");
                    for run in runs {
                        println!("  {} · phase {} · pid {:?}", run.id, run.phase, run.pid);
                    }
                    println!(
                        "Use `xcb recover <run-id> --yes` after verifying the process group is absent."
                    );
                }
            }
            Ok(0)
        }
        Some(Commands::EgressForward {
            socket,
            port,
            lo_up,
            env_file,
            target_port,
            child,
        }) => egress_forward(&socket, port, &lo_up, &env_file, target_port, &child).await,
        Some(Commands::Completions { shell }) => {
            clap_complete::generate(shell, &mut Cli::command(), "xcb", &mut io::stdout());
            Ok(0)
        }
    }
}

async fn chat(store: Arc<Store>, cwd: PathBuf, session: Option<Id>, json: bool) -> Result<i32> {
    if json {
        return Err(Error::Unavailable(
            "interactive chat is not a JSON transport; use xcb run --json",
        ));
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(Error::Unavailable(
            "chat requires a terminal; use xcb run for headless tasks",
        ));
    }
    let (updates, display) = sync_channel(256);
    let (commands, input) = sync_channel(32);
    let ui = tokio::task::spawn_blocking(move || xcb_tui::run(display, commands));
    let result = kernel::serve(store, cwd, session, input, updates).await;
    let ui = ui
        .await
        .map_err(|_| Error::Unavailable("terminal task failed"))?;
    ui?;
    result?;
    Ok(0)
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let code = match dispatch(cli).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("xcb: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_cli_shape_accepts_optional_run_and_yes() {
        let cli = Cli::try_parse_from(["xcb", "recover"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Recover {
                run: None,
                yes: false
            })
        ));

        let cli = Cli::try_parse_from(["xcb", "recover", "r_abc123"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Recover {
                run: Some(_),
                yes: false
            })
        ));

        let cli = Cli::try_parse_from(["xcb", "recover", "r_abc123", "--yes"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::Recover {
                run: Some(_),
                yes: true
            })
        ));
    }
}
