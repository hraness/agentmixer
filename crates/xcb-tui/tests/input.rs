use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use std::sync::mpsc::sync_channel;
use xcb_core::session::Attachment;
use xcb_tui::{
    App, Modal,
    composer::{Composer, ComposerAction},
};

#[test]
fn bracketed_paste_preserves_multiline_text_without_submitting() {
    let mut composer = Composer::default();
    assert!(matches!(
        composer.handle(Event::Paste("first\nsecond".into())),
        ComposerAction::None
    ));
    assert_eq!(composer.text(), "first\nsecond");
    let submit = composer.handle(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
    assert!(matches!(submit, ComposerAction::Submit(ref text) if text == "first\nsecond"));
}

#[test]
fn alt_enter_is_a_newline_and_unicode_editing_is_safe() {
    let mut composer = Composer::default();
    composer.handle(Event::Paste("λ東京".into()));
    composer.handle(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)));
    composer.handle(Event::Paste("next".into()));
    assert_eq!(composer.text(), "λ東京\nnext");
    composer.handle(Event::Key(KeyEvent::new(
        KeyCode::Backspace,
        KeyModifiers::NONE,
    )));
    assert_eq!(composer.text(), "λ東京\nnex");
}

#[test]
fn cancelling_never_submits_and_clipboard_has_its_own_action() {
    let mut composer = Composer::default();
    composer.handle(Event::Paste("do not send".into()));
    assert!(matches!(
        composer.handle(Event::Key(KeyEvent::new(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL
        ))),
        ComposerAction::Cancel
    ));
    assert!(composer.text().is_empty());
    assert!(matches!(
        composer.handle(Event::Key(KeyEvent::new(
            KeyCode::Char('v'),
            KeyModifiers::CONTROL
        ))),
        ComposerAction::Clipboard
    ));
}

#[test]
fn help_and_tail_navigation_do_not_modify_the_draft() {
    let (tx, _rx) = sync_channel(1);
    let mut app = App::default();
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE)),
        &tx,
    );
    assert!(matches!(app.modal, Some(Modal::Help)));
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
        &tx,
    );
    assert!(
        !app.paused.get(),
        "the help modal must capture unrelated keys"
    );
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE)),
        &tx,
    );
    assert!(app.modal.is_none(), "? must close help as advertised");

    app.composer.set_text("draft stays");
    // With no rendered geometry yet, PageUp pins the viewport at line 0.
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
        &tx,
    );
    assert!(app.paused.get());
    assert_eq!(app.scroll.get(), 0);
    // A paused viewport resumes tail-following once PageDown passes the tail.
    app.scroll.set(30);
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)),
        &tx,
    );
    assert!(!app.paused.get());
    assert_eq!(app.scroll.get(), 0);
    app.paused.set(true);
    app.scroll.set(30);
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)),
        &tx,
    );
    assert!(!app.paused.get());
    assert_eq!(app.scroll.get(), 0);
    assert_eq!(app.composer.text(), "draft stays");
}

#[test]
fn ctrl_c_cancels_the_run_even_while_a_dialog_is_open() {
    let (tx, rx) = sync_channel(4);
    let mut app = App::default();
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE)),
        &tx,
    );
    assert!(matches!(app.modal, Some(Modal::Help)));
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        &tx,
    );
    assert!(
        matches!(rx.try_recv(), Ok(xcb_core::ui::Intent::Cancel)),
        "Ctrl-C inside a dialog must reach the kernel as a cancel"
    );
    assert!(
        matches!(app.modal, Some(Modal::Help)),
        "the dialog stays open; Esc still closes it"
    );
    assert!(app.notice.contains("Stopping"));

    // The same holds for a picker dialog.
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        &tx,
    );
    assert!(app.modal.is_none());
    app.composer.set_text("/sessions");
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        &tx,
    );
    assert!(matches!(app.modal, Some(Modal::Picker { .. })));
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        &tx,
    );
    assert!(matches!(rx.try_recv(), Ok(xcb_core::ui::Intent::Cancel)));
    assert!(matches!(app.modal, Some(Modal::Picker { .. })));
}

#[test]
fn a_rejected_submission_restores_text_and_attachments() {
    let mut app = App::default();
    let image = Attachment {
        digest: "b".repeat(64),
        media_type: "image/png".into(),
        bytes: 1024,
        width: 320,
        height: 200,
    };
    assert!(app.apply(xcb_core::ui::Update::Draft {
        text: "rejected draft".into(),
        attachments: vec![image.clone()],
    }));
    assert_eq!(app.composer.text(), "rejected draft");
    assert_eq!(app.attachments.len(), 1);
    assert_eq!(app.attachments[0].digest, image.digest);

    // A draft the user typed meanwhile is never clobbered, and attachments
    // merge without duplicating a digest.
    app.composer.set_text("newer draft");
    assert!(app.apply(xcb_core::ui::Update::Draft {
        text: "older rejected".into(),
        attachments: vec![image.clone()],
    }));
    assert_eq!(app.composer.text(), "newer draft");
    assert_eq!(app.attachments.len(), 1);
}

#[test]
fn removing_an_attachment_retains_the_prompt() {
    let (tx, _rx) = sync_channel(1);
    let mut app = App::default();
    app.composer.set_text("keep this prompt");
    app.attachments.push(Attachment {
        digest: "a".repeat(64),
        media_type: "image/png".into(),
        bytes: 2048,
        width: 640,
        height: 480,
    });

    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::ALT)),
        &tx,
    );

    assert!(app.attachments.is_empty());
    assert_eq!(app.composer.text(), "keep this prompt");
}

fn view_for(session: &str) -> xcb_core::ui::View {
    xcb_core::ui::View {
        session: Some(xcb_core::session::Session {
            id: xcb_core::Id::new(session).unwrap(),
            account: xcb_core::Id::new("personal").unwrap(),
            model: xcb_core::models::ModelChoice {
                provider: xcb_core::Provider::Devin,
                id: xcb_core::Id::new("gpt-6-astra-max").unwrap(),
                label: "Astra Max".into(),
                mode: xcb_core::models::Mode::Fixed,
                resolved: None,
                effort: None,
                observed_at_ms: 1,
            },
            workspace: "/project".into(),
            title: format!("Session {session}"),
            pane: xcb_core::Id::new("focus").unwrap(),
            state: xcb_core::session::State::Idle,
            revision: 1,
            created_at_ms: 1,
            last_active_at_ms: 2,
        }),
        ..Default::default()
    }
}

#[test]
fn drafts_and_attachments_are_scoped_per_session() {
    let mut app = App::default();
    let image = |digest: &str| Attachment {
        digest: digest.repeat(8),
        media_type: "image/png".into(),
        bytes: 1024,
        width: 320,
        height: 200,
    };
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_one")))));
    app.composer.set_text("draft for one");
    app.attachments.push(image("aaaaaaa1"));

    // Switching sessions must not carry the draft or its images across.
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_two")))));
    assert_eq!(app.composer.text(), "");
    assert!(app.attachments.is_empty());
    app.composer.set_text("draft for two");
    app.attachments.push(image("bbbbbbb2"));

    // Each session gets its own draft back, attachments included.
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_one")))));
    assert_eq!(app.composer.text(), "draft for one");
    assert_eq!(app.attachments.len(), 1);
    assert_eq!(app.attachments[0].digest, "aaaaaaa1".repeat(8));
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_two")))));
    assert_eq!(app.composer.text(), "draft for two");
    assert_eq!(app.attachments[0].digest, "bbbbbbb2".repeat(8));
}

#[test]
fn an_attachment_in_flight_lands_in_the_session_that_requested_it() {
    let mut app = App::default();
    let (tx, _rx) = sync_channel(1);
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_one")))));
    // /attach sends the intent and records which session owns the image.
    app.composer.set_text("/attach /tmp/pic.png");
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        &tx,
    );
    let image = Attachment {
        digest: "c".repeat(64),
        media_type: "image/png".into(),
        bytes: 512,
        width: 16,
        height: 16,
    };
    // The user switches sessions before the image arrives.
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_two")))));
    assert!(app.apply(xcb_core::ui::Update::Attachment(image.clone())));
    assert!(
        app.attachments.is_empty(),
        "the image must not leak into the new session"
    );
    // Switching back restores the draft the image belongs to.
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view_for("s_one")))));
    assert_eq!(app.attachments.len(), 1);
    assert_eq!(app.attachments[0].digest, image.digest);
}

#[test]
fn unchanged_views_and_foreign_deltas_do_not_mark_a_repaint() {
    let mut app = App::default();
    assert!(!app.take_dirty(), "nothing drawn yet, nothing to repaint");

    let view = view_for("s_one");
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view.clone()))));
    assert!(app.take_dirty(), "a new snapshot must repaint");
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(view))));
    assert!(
        !app.take_dirty(),
        "an identical refresh must not trigger a rebuild"
    );

    // Stream text for a session that is not focused changes nothing on screen.
    assert!(app.apply(xcb_core::ui::Update::Delta {
        session: xcb_core::Id::new("s_elsewhere").unwrap(),
        thinking: false,
        text: "ignored".into(),
    }));
    assert!(!app.take_dirty());
    assert!(app.apply(xcb_core::ui::Update::Delta {
        session: xcb_core::Id::new("s_one").unwrap(),
        thinking: false,
        text: "kept".into(),
    }));
    assert!(app.take_dirty(), "a focused delta must repaint");
    assert_eq!(app.stream, "kept");

    // A changed snapshot repaints again.
    let mut changed = view_for("s_one");
    changed.state = xcb_core::session::State::Working;
    assert!(app.apply(xcb_core::ui::Update::View(Box::new(changed))));
    assert!(app.take_dirty());
}
