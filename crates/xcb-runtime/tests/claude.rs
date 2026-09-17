use xcb_core::policy::{Failure, Terminal};
use xcb_runtime::claude::{Event, parse_event};

#[test]
fn quota_failures_are_not_guessed_from_arbitrary_assistant_prose() {
    let prose = br#"{"type":"assistant","message":{"content":[{"type":"text","text":"The log says you hit a usage limit"}]}}"#;
    assert!(matches!(
        parse_event(prose).unwrap(),
        Event::Assistant { .. }
    ));
    let limit = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","resetsAt":2000000000,"utilization":1.0},"uuid":"x","session_id":"s"}"#;
    assert!(matches!(
        parse_event(limit).unwrap(),
        Event::Quota {
            failure: Some(Failure::AccountQuota),
            ..
        }
    ));
}

#[test]
fn stream_deltas_and_terminal_failures_have_distinct_types() {
    let delta = br#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}"#;
    assert!(
        matches!(parse_event(delta).unwrap(), Event::Delta { thinking: false, ref text } if text == "hello")
    );
    let end = br#"{"type":"result","subtype":"success","is_error":false,"result":"done","stop_reason":"end_turn"}"#;
    assert!(matches!(
        parse_event(end).unwrap(),
        Event::Result {
            terminal: Terminal::Completed,
            ..
        }
    ));
    let failed = br#"{"type":"result","subtype":"success","is_error":true,"result":"blocked"}"#;
    assert!(matches!(
        parse_event(failed).unwrap(),
        Event::Result {
            terminal: Terminal::Failed,
            ..
        }
    ));
}

#[test]
fn malformed_recognized_events_refuse_and_unknown_events_are_inert() {
    assert!(parse_event(br#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":7}}}"#).is_err());
    assert!(matches!(
        parse_event(br#"{"type":"future_notification"}"#).unwrap(),
        Event::Notice
    ));
    assert!(parse_event(br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","utilization":2.0}}"#).is_err());
}
