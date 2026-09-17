use ratatui::{Terminal, backend::TestBackend};
use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    panes::Pane,
    session::{Session, State},
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
