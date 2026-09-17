use ratatui::{Terminal, backend::TestBackend};
use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    panes::Pane,
    session::{Attachment, Message, MessageProvenance, Role, Session, State},
};
use xcb_tui::{App, render};

fn app() -> App {
    let mut app = App::default();
    app.view.session = Some(Session {
        id: Id::new("session").unwrap(),
        account: Id::new("personal").unwrap(),
        model: ModelChoice {
            provider: Provider::Devin,
            id: Id::new("gpt-6-astra-max").unwrap(),
            label: "Astra Max".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: None,
            observed_at_ms: 1,
        },
        workspace: "/project".into(),
        title: "Example".into(),
        pane: Id::new("focus").unwrap(),
        state: State::NeedsAnswer,
        revision: 1,
        created_at_ms: 1,
        last_active_at_ms: 2,
    });
    app.view.state = State::NeedsAnswer;
    app
}

#[test]
fn every_preset_and_narrow_terminal_retains_model_and_status_chrome() {
    for width in [40, 80, 120] {
        for pane in Pane::presets() {
            let mut app = app();
            app.view.pane = pane;
            let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
            terminal
                .draw(|frame| render::draw(frame, &mut app, 0))
                .unwrap();
            let contents: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(contents.contains("Astra Max"));
            assert!(contents.contains("needs answer"));
            assert!(!contents.contains("Context:"));
        }
    }
}

#[test]
fn tool_activity_is_hidden_until_explicitly_revealed() {
    let mut app = app();
    app.view.pane = Pane::presets().remove(2);
    app.view.activity = vec!["private tool detail".into()];
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| render::draw(frame, &mut app, 0))
        .unwrap();
    let hidden: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(hidden.contains("Tool activity hidden"));
    assert!(!hidden.contains("private tool detail"));
    app.show_activity = true;
    terminal
        .draw(|frame| render::draw(frame, &mut app, 0))
        .unwrap();
    let shown: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(shown.contains("private tool detail"));
}

#[test]
fn attachment_chips_help_and_paused_follow_state_are_visible() {
    let mut app = app();
    app.attachments.push(Attachment {
        digest: "a".repeat(64),
        media_type: "image/png".into(),
        bytes: 2048,
        width: 640,
        height: 480,
    });
    app.stream = "streaming line\n".repeat(50);
    app.scroll = 10;
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    terminal
        .draw(|frame| render::draw(frame, &mut app, 0))
        .unwrap();
    let contents: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(contents.contains("[image:png 640×480 · 2 KiB]"));
    assert!(contents.contains("paused · End follows"));
    assert!(contents.contains("? help"));
    assert!(contents.contains("? needs answer"));
}

#[test]
fn tiny_terminal_and_large_text_cannot_panic_the_renderer() {
    for (width, height) in [(0, 0), (1, 1), (20, 5), (40, 8), (200, 60)] {
        let mut app = app();
        app.stream = "long text\n".repeat(10_000);
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| render::draw(frame, &mut app, 0))
            .unwrap();
    }
}

fn provenance(run: Option<&str>) -> MessageProvenance {
    MessageProvenance {
        account: Id::new("personal").unwrap(),
        model: ModelChoice {
            provider: Provider::Devin,
            id: Id::new("gpt-6-astra-max").unwrap(),
            label: "Astra Max".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: None,
            observed_at_ms: 1,
        },
        run: run.map(|value| Id::new(value).unwrap()),
    }
}

#[test]
fn response_and_thinking_provenance_boundaries_are_visible_without_repetition() {
    let mut app = app();
    app.view.pane = Pane::focus();
    app.show_thinking = true;
    app.show_history = true;
    app.view.messages = vec![
        Message {
            id: Id::new("m1").unwrap(),
            role: Role::Assistant,
            text: "first".into(),
            attachments: vec![],
            at_ms: 1,
            provenance: Some(provenance(Some("r1"))),
        },
        Message {
            id: Id::new("m2").unwrap(),
            role: Role::Assistant,
            text: "second".into(),
            attachments: vec![],
            at_ms: 2,
            provenance: Some(provenance(Some("r1"))),
        },
        Message {
            id: Id::new("m3").unwrap(),
            role: Role::Assistant,
            text: "third".into(),
            attachments: vec![],
            at_ms: 3,
            provenance: Some(provenance(Some("r2"))),
        },
        Message {
            id: Id::new("m4").unwrap(),
            role: Role::Thinking,
            text: "thought".into(),
            attachments: vec![],
            at_ms: 4,
            provenance: Some(provenance(Some("r2"))),
        },
    ];
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal
        .draw(|frame| render::draw(frame, &mut app, 0))
        .unwrap();
    let contents: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert_eq!(contents.matches("r1").count(), 1);
    assert_eq!(contents.matches("r2").count(), 2);
    assert!(contents.contains("first"));
    assert!(contents.contains("second"));
    assert!(contents.contains("third"));
    assert!(contents.contains("thought"));
}
