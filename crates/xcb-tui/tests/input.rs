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
    assert_eq!(app.scroll, 0, "the help modal must capture unrelated keys");
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE)),
        &tx,
    );
    assert!(app.modal.is_none(), "? must close help as advertised");

    app.composer.set_text("draft stays");
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
        &tx,
    );
    assert_eq!(app.scroll, 10);
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)),
        &tx,
    );
    assert_eq!(app.scroll, 0);
    app.scroll = 30;
    app.handle(
        Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)),
        &tx,
    );
    assert_eq!(app.scroll, 0);
    assert_eq!(app.composer.text(), "draft stays");
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
