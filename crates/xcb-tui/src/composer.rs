use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use std::collections::VecDeque;
use tui_textarea::TextArea;

const MAX_INPUT: usize = 256 * 1024;

pub enum ComposerAction { None, Submit(String), Cancel, Quit, Clipboard, History, Editor }

pub struct Composer {
    pub textarea: TextArea<'static>,
    history: VecDeque<String>,
    history_index: Option<usize>,
    draft: String,
}
impl Default for Composer {
    fn default() -> Self { Self { textarea: TextArea::default(), history: VecDeque::new(), history_index: None, draft: String::new() } }
}
impl Composer {
    pub fn text(&self) -> String { self.textarea.lines().join("\n") }
    pub fn set_text(&mut self, text: &str) {
        if text.len() <= MAX_INPUT {
            self.textarea = TextArea::from(text.lines().map(str::to_owned));
            if text.ends_with('\n') { self.textarea = TextArea::from(text.split('\n').map(str::to_owned)); }
            self.textarea.move_cursor(tui_textarea::CursorMove::Bottom);
            self.textarea.move_cursor(tui_textarea::CursorMove::End);
        }
    }
    pub fn handle(&mut self, event: Event) -> ComposerAction {
        match event {
            Event::Paste(text) => {
                let text = text.replace("\r\n", "\n").replace('\r', "\n");
                let text = xcb_core::display_text(&text, MAX_INPUT);
                if self.text().len() + text.len() <= MAX_INPUT { self.textarea.insert_str(text); }
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                match key.code {
                    KeyCode::Char('c') if ctrl => { self.set_text(""); self.history_index = None; return ComposerAction::Cancel; }
                    KeyCode::Esc => return ComposerAction::Cancel,
                    KeyCode::Char('d') if ctrl && self.text().is_empty() => return ComposerAction::Quit,
                    KeyCode::Char('v') if ctrl => return ComposerAction::Clipboard,
                    KeyCode::Char('r') if ctrl => return ComposerAction::History,
                    KeyCode::Char('g') if ctrl => return ComposerAction::Editor,
                    KeyCode::Enter if key.modifiers.intersects(KeyModifiers::ALT | KeyModifiers::SHIFT) => { if self.text().len() < MAX_INPUT { self.textarea.insert_newline(); } }
                    KeyCode::Char('j') if ctrl => { if self.text().len() < MAX_INPUT { self.textarea.insert_newline(); } }
                    KeyCode::Enter => {
                        let text = self.text();
                        if !text.trim().is_empty() && self.history.front() != Some(&text) { self.history.push_front(text.clone()); self.history.truncate(200); }
                        self.set_text(""); self.history_index = None;
                        return ComposerAction::Submit(text);
                    }
                    KeyCode::Up if self.textarea.cursor().0 == 0 => {
                        if self.history_index.is_none() { self.draft = self.text(); }
                        let next = self.history_index.map_or(0, |value| value + 1);
                        if let Some(text) = self.history.get(next).cloned() { self.set_text(&text); self.history_index = Some(next); }
                    }
                    KeyCode::Down if self.history_index.is_some() => {
                        let index = self.history_index.expect("checked history index");
                        let (next, text) = if index == 0 { (None, self.draft.clone()) } else { (Some(index - 1), self.history[index - 1].clone()) };
                        self.set_text(&text); self.history_index = next;
                    }
                    _ => {
                        if self.text().len() < MAX_INPUT || !matches!(key.code, KeyCode::Char(_)) { self.textarea.input(key); }
                    }
                }
            }
            _ => (),
        }
        ComposerAction::None
    }
    pub fn history(&self) -> impl Iterator<Item = &String> { self.history.iter() }
}
