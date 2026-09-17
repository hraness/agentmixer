use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use xcb_tui::composer::{Composer, ComposerAction};

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
