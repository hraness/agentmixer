use crate::{App, Modal};
use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};
use xcb_core::{
    display_text,
    panes::{Node, Source},
    session::{Role, State},
};

fn status_color(state: State) -> Color {
    match state {
        State::Working => Color::Cyan,
        State::Idle => Color::Green,
        State::NeedsAnswer | State::NeedsApproval | State::NeedsAction | State::Limited => {
            Color::Yellow
        }
        State::Failed | State::Uncertain => Color::Red,
        State::Cancelled => Color::DarkGray,
    }
}
fn status_symbol(state: State) -> &'static str {
    match state {
        State::Idle => "○",
        State::Working => "●",
        State::NeedsAnswer => "?",
        State::NeedsAction => "!",
        State::NeedsApproval => "✓?",
        State::Limited => "↓",
        State::Failed => "×",
        State::Cancelled => "–",
        State::Uncertain => "!?",
    }
}

fn muted() -> Style {
    Style::default().fg(Color::DarkGray)
}
fn clean(text: &str) -> String {
    display_text(text, 256 * 1024)
}

pub fn draw(frame: &mut Frame<'_>, app: &mut App, ticks: u64) {
    let area = frame.area();
    if area.width < 24 || area.height < 7 {
        frame.render_widget(
            Paragraph::new("xcb · enlarge the terminal\nCtrl-C cancels · Ctrl-D exits"),
            area,
        );
        return;
    }
    let attachment_height = (app.attachments.len() as u16).min(3);
    let input_height = (app.composer.textarea.lines().len() as u16)
        .saturating_add(2)
        .clamp(3, 8)
        .min(area.height.saturating_sub(4 + attachment_height));
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
            Constraint::Length(attachment_height),
            Constraint::Length(input_height),
            Constraint::Length(1),
        ])
        .split(area);
    let project = app
        .view
        .session
        .as_ref()
        .and_then(|session| std::path::Path::new(&session.workspace).file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "local workspace".into());
    let rate = app
        .view
        .tokens_per_second
        .map(|rate| format!("{rate:.1} tok/s"))
        .unwrap_or_else(|| "usage: unmeasured".into());
    let rate = app
        .view
        .share_percent
        .map(|share| format!("{rate} · {share:.0}% local"))
        .unwrap_or(rate);
    let header = Layout::horizontal([
        Constraint::Min(8),
        Constraint::Length((rate.len() as u16).min(area.width / 2)),
    ])
    .split(parts[0]);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("xcb", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(format!(" · {}", clean(&project)), muted()),
        ])),
        header[0],
    );
    let heat = match app.view.share_percent {
        Some(percent) if percent >= 50.0 => Color::LightRed,
        Some(percent) if percent >= 20.0 => Color::Yellow,
        Some(_) => Color::Cyan,
        None => Color::DarkGray,
    };
    frame.render_widget(
        Paragraph::new(rate)
            .alignment(Alignment::Right)
            .style(Style::default().fg(heat)),
        header[1],
    );
    render_node(frame, &app.view.pane.root, parts[1], app);
    let notice = app.view.pane_error.as_deref().unwrap_or(&app.notice);
    frame.render_widget(
        Paragraph::new(clean(notice)).style(Style::default().fg(Color::Yellow)),
        parts[2],
    );
    if !app.attachments.is_empty() {
        let visible = app
            .attachments
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(|attachment| {
                let kind = attachment
                    .media_type
                    .strip_prefix("image/")
                    .unwrap_or(&attachment.media_type);
                Line::from(format!(
                    "[image:{} {}×{} · {} KiB]",
                    display_text(kind, 32),
                    attachment.width,
                    attachment.height,
                    attachment.bytes.div_ceil(1024)
                ))
            });
        frame.render_widget(
            Paragraph::new(Text::from_iter(visible)).style(muted()),
            parts[3],
        );
    }
    let attachment_hint = if app.attachments.is_empty() {
        String::new()
    } else {
        format!(
            " {} attached · Alt-Backspace removes last ",
            app.attachments.len()
        )
    };
    app.composer.textarea.set_block(
        Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(Style::default().fg(status_color(app.view.state)))
            .title(attachment_hint),
    );
    app.composer
        .textarea
        .set_cursor_line_style(Style::default());
    app.composer
        .textarea
        .set_placeholder_text(if app.view.state == State::Working {
            "Type a follow-up while the agent works"
        } else {
            "Message, /model, /accounts, /pane · Ctrl-V pastes images"
        });
    frame.render_widget(&app.composer.textarea, parts[4]);
    let mut color = status_color(app.view.state);
    if app.view.state.attention() && !app.view.reduced_motion && (ticks / 16).is_multiple_of(2) {
        color = Color::LightYellow;
    }
    let status = format!(
        " {} {} ",
        status_symbol(app.view.state),
        app.view.state.label()
    );
    let footer = Layout::horizontal([
        Constraint::Min(0),
        Constraint::Length(status.chars().count() as u16),
    ])
    .split(parts[5]);
    let model = app
        .view
        .session
        .as_ref()
        .map(|session| {
            format!(
                "{} · {} · ? help",
                session.model.provider, session.model.label
            )
        })
        .unwrap_or_else(|| "Choose an account with /accounts · ? help".into());
    frame.render_widget(
        Paragraph::new(clean(&model)).style(Style::default().add_modifier(Modifier::BOLD)),
        footer[0],
    );
    frame.render_widget(
        Paragraph::new(status).alignment(Alignment::Right).style(
            Style::default()
                .bg(color)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD),
        ),
        footer[1],
    );
    if let Some(modal) = &mut app.modal {
        render_modal(frame, modal, area);
    }
}

fn preferred_height(node: &Node) -> Constraint {
    match node {
        Node::Widget {
            lines: Some(lines), ..
        }
        | Node::Spacer { lines } => Constraint::Length(*lines),
        Node::Text { value } => Constraint::Length(value.lines().count().clamp(1, 6) as u16),
        _ => Constraint::Min(1),
    }
}

fn render_node(frame: &mut Frame<'_>, node: &Node, area: Rect, app: &App) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    match node {
        Node::Column { children } | Node::Row { children } => {
            let horizontal = matches!(node, Node::Row { .. });
            let constraints: Vec<_> = children
                .iter()
                .map(|node| {
                    if horizontal {
                        Constraint::Ratio(1, children.len() as u32)
                    } else {
                        preferred_height(node)
                    }
                })
                .collect();
            let chunks = Layout::default()
                .direction(if horizontal {
                    Direction::Horizontal
                } else {
                    Direction::Vertical
                })
                .constraints(constraints)
                .split(area);
            for (child, chunk) in children.iter().zip(chunks.iter()) {
                render_node(frame, child, *chunk, app);
            }
        }
        Node::Widget { source, .. } => render_source(frame, *source, area, app),
        Node::Text { value } => frame.render_widget(
            Paragraph::new(clean(value)).wrap(Wrap { trim: false }),
            area,
        ),
        Node::Spacer { .. } => (),
    }
}

fn render_source(frame: &mut Frame<'_>, source: Source, area: Rect, app: &App) {
    let mut lines = Vec::new();
    match source {
        Source::LastUser => {
            lines.push(Line::from(Span::styled(
                "You",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )));
            match app
                .view
                .messages
                .iter()
                .rev()
                .find(|message| message.role == Role::User)
            {
                Some(message) => {
                    lines.extend(
                        clean(&message.text)
                            .lines()
                            .map(|line| Line::from(line.to_owned())),
                    );
                    if !message.attachments.is_empty() {
                        lines.push(Line::from(Span::styled(
                            format!("{} attached image(s)", message.attachments.len()),
                            muted(),
                        )));
                    }
                }
                None => lines.push(Line::from(
                    "Bring your accounts. Choose your models. Make the terminal yours.",
                )),
            }
        }
        Source::Thinking => {
            let heading = if app.show_thinking {
                "▾ Thinking · Ctrl-T collapses"
            } else {
                "▸ Thinking · Ctrl-T expands"
            };
            lines.push(Line::from(Span::styled(
                if app.scroll > 0 {
                    format!("{heading} · ↑ paused · End follows")
                } else {
                    heading.into()
                },
                muted(),
            )));
            if app.show_thinking {
                let text = if app.thinking.is_empty() {
                    app.view
                        .messages
                        .iter()
                        .rev()
                        .find(|message| message.role == Role::Thinking)
                        .map(|message| message.text.as_str())
                        .unwrap_or("No thinking text reported.")
                } else {
                    &app.thinking
                };
                lines.extend(
                    clean(text)
                        .lines()
                        .map(|line| Line::from(Span::styled(line.to_owned(), muted()))),
                );
            }
        }
        Source::Responses => {
            let heading = if app.show_history {
                "▾ Responses · Ctrl-O collapses history"
            } else {
                "▸ Earlier responses · Ctrl-O expands"
            };
            lines.push(Line::from(Span::styled(
                if app.scroll > 0 {
                    format!("{heading} · ↑ paused · End follows")
                } else {
                    heading.into()
                },
                muted(),
            )));
            let responses: Vec<_> = app
                .view
                .messages
                .iter()
                .filter(|message| message.role == Role::Assistant)
                .collect();
            let selected = if app.show_history {
                responses.as_slice()
            } else {
                &responses[responses.len().saturating_sub(1)..]
            };
            for message in selected {
                lines.extend(
                    clean(&message.text)
                        .lines()
                        .map(|line| Line::from(line.to_owned())),
                );
                lines.push(Line::default());
            }
            if !app.stream.is_empty() {
                lines.extend(
                    clean(&app.stream)
                        .lines()
                        .map(|line| Line::from(line.to_owned())),
                );
            }
            if selected.is_empty() && app.stream.is_empty() {
                lines.push(Line::from(Span::styled(
                    "/help for commands · /pane to change this view",
                    muted(),
                )));
            }
        }
        Source::Subagents => {
            lines.push(Line::from(Span::styled("Subagents", muted())));
            if app.view.subagents.is_empty() {
                lines.push(Line::from(Span::styled(
                    "No subagent activity reported",
                    muted(),
                )));
            }
            for agent in &app.view.subagents {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("[{}] ", agent.state.label()),
                        Style::default().fg(status_color(agent.state)),
                    ),
                    Span::raw(clean(&agent.label)),
                    Span::styled(
                        agent
                            .model
                            .as_ref()
                            .map(|model| format!(" · {model}"))
                            .unwrap_or_default(),
                        muted(),
                    ),
                ]));
            }
        }
        Source::Accounts => {
            lines.push(Line::from(Span::styled(
                "Accounts · /accounts",
                Style::default().add_modifier(Modifier::BOLD),
            )));
            for account in &app.view.accounts {
                let remaining = account
                    .remaining_percent
                    .map(|remaining| format!("{remaining:.0}% left"))
                    .unwrap_or_else(|| "quota unknown".into());
                let time = account
                    .runway
                    .seconds()
                    .map(|seconds| format!(" · ~{:.1}h", seconds / 3600.0))
                    .unwrap_or_default();
                lines.push(Line::from(format!(
                    "{} {} · {} · {remaining}{time}{}",
                    if account.busy { "*" } else { " " },
                    clean(&account.label),
                    account.provider,
                    if account.enabled { "" } else { " · disabled" }
                )));
            }
            if let Some(seconds) = app.view.total_runway_seconds {
                lines.push(Line::from(Span::styled(
                    format!(
                        "~{:.1}h measured pool runway · {}/{} pools",
                        seconds / 3600.0,
                        app.view.runway_coverage.0,
                        app.view.runway_coverage.1
                    ),
                    muted(),
                )));
            }
        }
        Source::Models => {
            lines.push(Line::from(Span::styled(
                "Models · favorites first",
                muted(),
            )));
            for model in app.view.models.iter().take(24) {
                lines.push(Line::from(format!(
                    "{} · {}",
                    model.provider,
                    clean(&model.label)
                )));
            }
        }
        Source::Usage => {
            lines.push(Line::from("Observed output velocity · rolling 60s"));
            lines.push(Line::from(
                app.view
                    .tokens_per_second
                    .map(|rate| format!("{rate:.1} tok/s"))
                    .unwrap_or_else(|| "Unmeasured; waiting for comparable samples".into()),
            ));
            lines.push(Line::from(
                app.view
                    .share_percent
                    .map(|share| format!("{share:.0}% of measured local throughput"))
                    .unwrap_or_else(|| "Local throughput share unavailable".into()),
            ));
        }
        Source::Activity => {
            lines.push(Line::from(Span::styled(
                if app.show_activity {
                    "Tool activity · Ctrl-U hides"
                } else {
                    "Tool activity hidden · Ctrl-U reveals"
                },
                muted(),
            )));
            if app.show_activity {
                lines.extend(
                    app.view
                        .activity
                        .iter()
                        .rev()
                        .take(32)
                        .rev()
                        .map(|text| Line::from(clean(text))),
                );
            }
        }
        Source::Extensions => {
            lines.extend(
                app.view
                    .extensions
                    .iter()
                    .map(|(name, state)| Line::from(format!("{name}: {state}"))),
            );
        }
    }
    let scroll = if matches!(source, Source::Responses | Source::Thinking) {
        let width = area.width.max(1) as usize;
        let content_height: usize = lines
            .iter()
            .map(|line| line.width().max(1).div_ceil(width))
            .sum();
        let tail =
            u16::try_from(content_height.saturating_sub(area.height as usize)).unwrap_or(u16::MAX);
        tail.saturating_sub(app.scroll.min(tail))
    } else {
        0
    };
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        area,
    );
}

fn modal_area(area: Rect) -> Rect {
    let width = area.width.saturating_sub(4).min(110);
    let height = area.height.saturating_sub(2);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

fn render_modal(frame: &mut Frame<'_>, modal: &mut Modal, area: Rect) {
    let area = modal_area(area);
    frame.render_widget(Clear, area);
    match modal {
        Modal::Help => {
            let block = Block::bordered()
                .title(" Keyboard & commands ")
                .title_bottom(" ? or Esc closes ");
            let inner = block.inner(area);
            frame.render_widget(block, area);
            frame.render_widget(
                Paragraph::new(
                    [
                        "Enter send · Alt/Shift-Enter or Ctrl-J newline",
                        "Ctrl-V paste text/image · Alt-Backspace remove last attachment",
                        "PageUp pause/older · PageDown newer · End follow newest",
                        "Ctrl-T thinking · Ctrl-O history · Ctrl-U tools",
                        "Ctrl-P models · Ctrl-R prompt history · Ctrl-G editor",
                        "Ctrl-C/Esc cancel · Ctrl-D quit when draft is empty",
                        "",
                        "/model · /accounts · /sessions · /new · /default",
                        "/pane [edit|generate …] · /attach <path>",
                        "/plugin <name> on|off · /reload · /quit",
                    ]
                    .join("\n"),
                )
                .wrap(Wrap { trim: false }),
                inner,
            );
        }
        Modal::Picker {
            title,
            query,
            items,
            selected,
        } => {
            let block = Block::bordered()
                .title(format!(" {title} · {query} "))
                .title_bottom(" Type to filter · Enter selects · Esc closes ");
            let inner = block.inner(area);
            frame.render_widget(block, area);
            let visible: Vec<_> = items
                .iter()
                .filter(|item| item.label.to_lowercase().contains(&query.to_lowercase()))
                .map(|item| ListItem::new(clean(&item.label)))
                .collect();
            *selected = (*selected).min(visible.len().saturating_sub(1));
            let mut state =
                ListState::default().with_selected((!visible.is_empty()).then_some(*selected));
            frame.render_stateful_widget(
                List::new(visible)
                    .highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White))
                    .highlight_symbol("› "),
                inner,
                &mut state,
            );
        }
        Modal::Editor {
            title,
            textarea,
            error,
            ..
        } => {
            textarea.set_block(
                Block::bordered()
                    .title(format!(" {title} "))
                    .title_bottom(" Ctrl-S saves · Esc cancels · no code is executed "),
            );
            textarea.set_cursor_line_style(Style::default());
            frame.render_widget(&**textarea, area);
            if let Some(error) = error {
                frame.render_widget(
                    Paragraph::new(clean(error)).style(Style::default().fg(Color::Yellow)),
                    Rect::new(
                        area.x + 1,
                        area.y + area.height.saturating_sub(2),
                        area.width.saturating_sub(2),
                        1,
                    ),
                );
            }
        }
    }
}
