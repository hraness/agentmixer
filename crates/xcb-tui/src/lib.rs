pub mod composer;
pub mod render;

use composer::{Composer, ComposerAction};
use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind,
        KeyModifiers, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
        PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{
    io::{self, IsTerminal},
    sync::mpsc::{Receiver, SyncSender, TryRecvError},
    time::{Duration, Instant},
};
use tui_textarea::TextArea;
use xcb_core::{
    Id,
    panes::Pane,
    session::Attachment,
    ui::{Intent, Update, View},
};

#[derive(Clone)]
pub enum PickAction {
    Pane(Id),
    Model(String),
    Account(Id),
    Session(Id),
    Text(String),
    EditPane,
}
#[derive(Clone)]
pub struct PickItem {
    pub label: String,
    pub action: PickAction,
}

pub enum EditorKind {
    Prompt,
    Pane { expected: Option<String> },
}
pub enum Modal {
    Picker {
        title: String,
        query: String,
        items: Vec<PickItem>,
        selected: usize,
    },
    Editor {
        title: String,
        textarea: Box<TextArea<'static>>,
        kind: EditorKind,
        error: Option<String>,
    },
    Help,
}

#[derive(Default)]
pub struct App {
    pub view: View,
    pub composer: Composer,
    pub stream: String,
    pub thinking: String,
    pub notice: String,
    pub attachments: Vec<Attachment>,
    pub modal: Option<Modal>,
    pub show_thinking: bool,
    pub show_history: bool,
    pub show_activity: bool,
    pub scroll: u16,
    pending_image: bool,
}
impl App {
    pub fn apply(&mut self, update: Update) -> bool {
        match update {
            Update::View(mut view) => {
                if view.pane_error.is_some() {
                    view.pane = self.view.pane.clone();
                    view.pane_revision = self.view.pane_revision.clone();
                }
                if self.view.session.as_ref().map(|session| &session.id)
                    != view.session.as_ref().map(|session| &session.id)
                {
                    self.stream.clear();
                    self.thinking.clear();
                    self.scroll = 0;
                }
                self.view = *view;
            }
            Update::Delta {
                session,
                thinking,
                text,
            } if self
                .view
                .session
                .as_ref()
                .is_some_and(|current| current.id == session) =>
            {
                let target = if thinking {
                    &mut self.thinking
                } else {
                    &mut self.stream
                };
                let remaining = xcb_core::MAX_TEXT_BYTES.saturating_sub(target.len());
                target.push_str(&xcb_core::display_text(&text, remaining));
            }
            Update::ClearStream(session)
                if self
                    .view
                    .session
                    .as_ref()
                    .is_some_and(|current| current.id == session) =>
            {
                self.stream.clear();
                self.thinking.clear();
            }
            Update::Attachment(attachment) => {
                self.pending_image = false;
                if self.attachments.len() < 8 {
                    self.attachments.push(attachment);
                }
            }
            Update::PaneCandidate(pane) => self.edit_pane(&pane, None),
            Update::Notice(text) => {
                self.pending_image = false;
                self.notice = xcb_core::display_text(&text, 1024);
            }
            Update::Stopped => return false,
            _ => (),
        }
        true
    }
    fn picker(&mut self, title: &str, items: Vec<PickItem>) {
        self.modal = Some(Modal::Picker {
            title: title.into(),
            query: String::new(),
            items,
            selected: 0,
        });
    }
    fn edit_pane(&mut self, pane: &Pane, expected: Option<String>) {
        let text = serde_json::to_string_pretty(pane).expect("valid pane");
        self.modal = Some(Modal::Editor {
            title: "Pane declaration · Ctrl-S validates and applies".into(),
            textarea: Box::new(TextArea::from(text.lines())),
            kind: EditorKind::Pane { expected },
            error: None,
        });
    }
    fn send(&mut self, output: &SyncSender<Intent>, intent: Intent) {
        if output.try_send(intent).is_err() {
            self.notice = "The command queue is full or closed. Nothing was submitted.".into();
        }
    }
    fn slash(&mut self, input: &str, output: &SyncSender<Intent>) -> bool {
        let (command, arguments) = input.split_once(' ').unwrap_or((input, ""));
        let arguments = arguments.trim();
        match command {
            "/help" => self.notice = "/model · /accounts · /sessions · /new · /default · /pane [edit|generate ...] · /attach path · /plugin name on|off · Ctrl-T thinking · Ctrl-O history · Ctrl-U tools · /quit".into(),
            "/quit" | "/exit" => { self.send(output, Intent::Quit); return false; }
            "/new" => self.send(output, Intent::NewSession),
            "/default" => self.send(output, Intent::SetDefault),
            "/model" | "/models" if arguments.is_empty() => self.picker("Models · fixed, Adaptive, and Fusion", self.view.models.iter().map(|choice| PickItem { label: format!("{} · {}{} · {:?}", choice.provider, choice.label, choice.resolved.as_ref().map(|resolved| format!(" → {resolved}")).unwrap_or_default(), choice.mode), action: PickAction::Model(choice.key()) }).collect()),
            "/model" => self.send(output, Intent::Model(arguments.into())),
            "/accounts" => self.picker("Accounts · select an account", self.view.accounts.iter().map(|account| PickItem { label: format!("{} · {} · {} · {}{}", account.label, account.provider, account.subscription, account.remaining_percent.map(|percent| format!("{percent:.0}% left")).unwrap_or_else(|| "quota unknown".into()), if account.busy { " · busy" } else { "" }), action: PickAction::Account(account.id.clone()) }).collect()),
            "/sessions" => self.picker("Sessions", self.view.sessions.iter().map(|session| PickItem { label: format!("{} · {} · {}", session.title, session.model.label, session.state.label()), action: PickAction::Session(session.id.clone()) }).collect()),
            "/pane" if arguments.is_empty() => {
                let mut items: Vec<_> = self.view.panes.iter().map(|pane| PickItem { label: format!("{} · {}", pane.id, pane.title), action: PickAction::Pane(pane.id.clone()) }).collect();
                items.push(PickItem { label: "Edit this pane".into(), action: PickAction::EditPane });
                items.push(PickItem { label: "Generate a pane…".into(), action: PickAction::Text("/pane generate ".into()) });
                self.picker("Panes", items);
            }
            "/pane" if arguments == "edit" => self.edit_pane(&self.view.pane.clone(), self.view.pane_revision.clone()),
            "/pane" if arguments.starts_with("generate ") => self.send(output, Intent::GeneratePane(arguments[9..].into())),
            "/pane" => match Id::new(arguments) { Ok(id) => self.send(output, Intent::Pane(id)), Err(_) => self.notice = "Use /pane, /pane edit, or /pane generate <description>".into() },
            "/attach" if !arguments.is_empty() => { self.pending_image = true; self.send(output, Intent::AttachPath(arguments.trim_matches('"').trim_matches('\'').into())); }
            "/plugin" => {
                let pieces: Vec<_> = arguments.split_whitespace().collect();
                if pieces.len() == 2 && ["on", "off"].contains(&pieces[1]) { self.send(output, Intent::Extension { name: pieces[0].into(), enabled: pieces[1] == "on" }); }
                else { self.notice = "/plugin auto-continue|gobstopper|usage|hooks on|off".into(); }
            }
            "/reload" => self.send(output, Intent::Refresh),
            _ => self.notice = "Unknown command. /help lists commands; no command text was sent to the model.".into(),
        }
        true
    }
    pub fn handle(&mut self, event: Event, output: &SyncSender<Intent>) -> bool {
        if self.modal.is_some() {
            self.modal_event(event, output);
            return true;
        }
        if let Event::Key(key) = &event {
            if key.kind == KeyEventKind::Release {
                return true;
            }
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match key.code {
                    KeyCode::Char('t') => {
                        self.show_thinking = !self.show_thinking;
                        return true;
                    }
                    KeyCode::Char('o') => {
                        self.show_history = !self.show_history;
                        return true;
                    }
                    KeyCode::Char('u') => {
                        self.show_activity = !self.show_activity;
                        return true;
                    }
                    KeyCode::Char('p') => {
                        self.slash("/model", output);
                        return true;
                    }
                    KeyCode::Char('l') => {
                        self.send(output, Intent::Refresh);
                        return true;
                    }
                    _ => (),
                }
            }
            match key.code {
                KeyCode::Char('?') if self.composer.text().is_empty() => {
                    self.modal = Some(Modal::Help);
                    return true;
                }
                KeyCode::PageUp => {
                    self.scroll = self.scroll.saturating_add(10);
                    return true;
                }
                KeyCode::PageDown => {
                    self.scroll = self.scroll.saturating_sub(10);
                    return true;
                }
                KeyCode::End => {
                    self.scroll = 0;
                    return true;
                }
                KeyCode::Backspace if key.modifiers.contains(KeyModifiers::ALT) => {
                    self.attachments.pop();
                    return true;
                }
                KeyCode::Tab if self.composer.text().starts_with('/') => {
                    let current = self.composer.text();
                    if let Some(command) = [
                        "/accounts",
                        "/attach ",
                        "/default",
                        "/help",
                        "/model",
                        "/new",
                        "/pane",
                        "/plugin ",
                        "/quit",
                        "/reload",
                        "/sessions",
                    ]
                    .into_iter()
                    .find(|command| command.starts_with(&current))
                    {
                        self.composer.set_text(command);
                    }
                    return true;
                }
                _ => (),
            }
        }
        if self.pending_image && matches!(&event, Event::Key(key) if key.code == KeyCode::Enter) {
            self.notice = "Waiting for the image to finish loading; your draft is retained.".into();
            return true;
        }
        match self.composer.handle(event) {
            ComposerAction::Submit(text) => {
                if text.starts_with('/') {
                    return self.slash(&text, output);
                }
                if !text.trim().is_empty() || !self.attachments.is_empty() {
                    let attachments = std::mem::take(&mut self.attachments);
                    match output.try_send(Intent::Submit { text, attachments }) {
                        Ok(()) => self.notice.clear(),
                        Err(
                            std::sync::mpsc::TrySendError::Full(Intent::Submit {
                                text,
                                attachments,
                            })
                            | std::sync::mpsc::TrySendError::Disconnected(Intent::Submit {
                                text,
                                attachments,
                            }),
                        ) => {
                            self.composer.set_text(&text);
                            self.attachments = attachments;
                            self.notice = "Command queue unavailable; draft retained.".into();
                        }
                        Err(_) => (),
                    }
                }
            }
            ComposerAction::Cancel => {
                self.send(output, Intent::Cancel);
                self.notice = "Stopping the current turn and queued follow-ups.".into();
            }
            ComposerAction::Quit => {
                self.send(output, Intent::Quit);
                return false;
            }
            ComposerAction::Clipboard => self.clipboard(output),
            ComposerAction::History => self.picker(
                "Prompt history",
                self.composer
                    .history()
                    .map(|text| PickItem {
                        label: text.lines().next().unwrap_or("").into(),
                        action: PickAction::Text(text.clone()),
                    })
                    .collect(),
            ),
            ComposerAction::Editor => {
                self.modal = Some(Modal::Editor {
                    title: "Prompt editor".into(),
                    textarea: Box::new(self.composer.textarea.clone()),
                    kind: EditorKind::Prompt,
                    error: None,
                })
            }
            ComposerAction::None => (),
        }
        true
    }
    fn clipboard(&mut self, output: &SyncSender<Intent>) {
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            self.notice =
                "Clipboard unavailable. Paste text normally or use /attach <path>.".into();
            return;
        };
        if let Ok(image) = clipboard.get_image() {
            if self.attachments.len() >= 8
                || image
                    .width
                    .checked_mul(image.height)
                    .is_none_or(|pixels| pixels > 16_000_000)
            {
                self.notice = "Image limit reached (8 images, 16 megapixels each).".into();
                return;
            }
            self.pending_image = true;
            self.send(
                output,
                Intent::AttachRgba {
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes.into_owned(),
                },
            );
        } else if let Ok(text) = clipboard.get_text() {
            self.composer.handle(Event::Paste(text));
        } else {
            self.notice = "No supported text or image on the clipboard.".into();
        }
    }
    fn modal_event(&mut self, event: Event, output: &SyncSender<Intent>) {
        if matches!(
            (&self.modal, &event),
            (
                Some(Modal::Help),
                Event::Key(key)
            ) if key.kind != KeyEventKind::Release
                && matches!(key.code, KeyCode::Char('?') | KeyCode::Esc)
        ) || matches!(
            &event,
            Event::Key(key) if key.kind != KeyEventKind::Release && key.code == KeyCode::Esc
        ) {
            self.modal = None;
            return;
        }
        let mut chosen = None;
        let mut save = None;
        if let Some(modal) = &mut self.modal {
            match modal {
                Modal::Picker {
                    query,
                    items,
                    selected,
                    ..
                } => {
                    if let Event::Key(key) = event {
                        if key.kind == KeyEventKind::Release {
                            return;
                        }
                        match key.code {
                            KeyCode::Up => *selected = selected.saturating_sub(1),
                            KeyCode::Down => *selected = selected.saturating_add(1),
                            KeyCode::Backspace => {
                                query.pop();
                                *selected = 0;
                            }
                            KeyCode::Char(ch)
                                if !key
                                    .modifiers
                                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                                    && query.len() < 128 =>
                            {
                                query.push(ch);
                                *selected = 0;
                            }
                            KeyCode::Enter => {
                                chosen = items
                                    .iter()
                                    .filter(|item| {
                                        item.label.to_lowercase().contains(&query.to_lowercase())
                                    })
                                    .nth(*selected)
                                    .map(|item| item.action.clone())
                            }
                            _ => (),
                        }
                    }
                }
                Modal::Help => {}
                Modal::Editor {
                    textarea,
                    kind,
                    error,
                    ..
                } => {
                    if matches!(&event, Event::Key(key) if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL))
                    {
                        let text = textarea.lines().join("\n");
                        match kind {
                            EditorKind::Prompt => chosen = Some(PickAction::Text(text)),
                            EditorKind::Pane { expected } => match Pane::parse(text.as_bytes()) {
                                Ok(pane) => save = Some((pane, expected.clone())),
                                Err(problem) => *error = Some(problem.to_string()),
                            },
                        }
                    } else {
                        match event {
                            Event::Paste(text)
                                if textarea.lines().iter().map(String::len).sum::<usize>()
                                    + text.len()
                                    <= 64 * 1024 =>
                            {
                                textarea.insert_str(xcb_core::display_text(
                                    &text.replace("\r\n", "\n"),
                                    64 * 1024,
                                ));
                            }
                            Event::Key(key)
                                if key.kind != KeyEventKind::Release
                                    && (textarea
                                        .lines()
                                        .iter()
                                        .map(String::len)
                                        .sum::<usize>()
                                        < 64 * 1024
                                        || !matches!(key.code, KeyCode::Char(_))) =>
                            {
                                textarea.input(key);
                            }
                            _ => (),
                        }
                    }
                }
            }
        }
        if let Some((pane, expected)) = save {
            self.modal = None;
            self.send(output, Intent::SavePane { pane, expected });
        }
        if let Some(action) = chosen {
            self.modal = None;
            match action {
                PickAction::Pane(id) => self.send(output, Intent::Pane(id)),
                PickAction::Model(id) => self.send(output, Intent::Model(id)),
                PickAction::Account(id) => self.send(output, Intent::Account(id)),
                PickAction::Session(id) => self.send(output, Intent::Resume(id)),
                PickAction::Text(text) => self.composer.set_text(&text),
                PickAction::EditPane => {
                    self.edit_pane(&self.view.pane.clone(), self.view.pane_revision.clone())
                }
            }
        }
    }
}

struct Restore;
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
            PopKeyboardEnhancementFlags,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

pub fn run(input: Receiver<Update>, output: SyncSender<Intent>) -> io::Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(io::Error::other(
            "xcb chat needs a terminal; use xcb run for headless work",
        ));
    }
    enable_raw_mode()?;
    let _restore = Restore;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    )?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut app = App::default();
    let mut ticks = 0u64;
    let mut refresh = Instant::now();
    loop {
        for _ in 0..128 {
            match input.try_recv() {
                Ok(update) => {
                    if !app.apply(update) {
                        return Ok(());
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }
        terminal.draw(|frame| render::draw(frame, &mut app, ticks))?;
        if event::poll(Duration::from_millis(50))? && !app.handle(event::read()?, &output) {
            break;
        }
        ticks = ticks.wrapping_add(1);
        if refresh.elapsed() >= Duration::from_millis(750) {
            app.send(&output, Intent::Refresh);
            refresh = Instant::now();
        }
    }
    Ok(())
}
