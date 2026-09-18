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

#[test]
fn subagent_events_preserve_reported_model_metadata() {
    let event = br#"{"type":"system","subtype":"task_started","task_id":"agent_1","description":"Review tests","model":"claude-fable-5-1"}"#;
    assert!(matches!(
        parse_event(event).unwrap(),
        Event::Subagent { ref model, .. } if model.as_deref() == Some("claude-fable-5-1")
    ));
    let oversized = format!(
        "{{\"type\":\"system\",\"subtype\":\"task_started\",\"task_id\":\"agent_1\",\"model\":\"{}\"}}",
        "x".repeat(161)
    );
    assert!(parse_event(oversized.as_bytes()).is_err());
}

#[test]
fn catalog_keeps_selection_token_and_resolved_model_separate() {
    let catalog = serde_json::json!({"models":[
        {"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)","supportedEffortLevels":["high","max"]},
        {"value":"opus[1m]","resolvedModel":"claude-opus-5[1m]","displayName":"Opus (1M context)","supportedEffortLevels":["max"]},
        {"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku"}
    ]});
    let choices = xcb_runtime::runner::parse_models(&catalog, 10).unwrap();
    let default = choices
        .iter()
        .find(|c| {
            c.id.as_str() == "default" && c.effort.as_ref().is_none_or(|e| e.as_str() == "high")
        })
        .unwrap();
    assert_eq!(
        default.resolved.as_ref().unwrap().as_str(),
        "claude-opus-5[1m]"
    );
    let opus = choices
        .iter()
        .find(|c| c.id.as_str() == "opus[1m]")
        .unwrap();
    assert_eq!(
        opus.resolved.as_ref().unwrap().as_str(),
        "claude-opus-5[1m]"
    );
    let haiku = choices.iter().find(|c| c.id.as_str() == "haiku").unwrap();
    assert_eq!(
        haiku.resolved.as_ref().unwrap().as_str(),
        "claude-haiku-4-5-20251001"
    );
    assert!(haiku.effort.is_none());
}

#[test]
fn version_admission_is_a_major_bounded_floor() {
    use xcb_runtime::claude::{MAX_MAJOR, MIN_VERSION, version_admitted};
    assert_eq!(MIN_VERSION, "2.1.268");
    assert_eq!(MAX_MAJOR, 2);
    for admitted in ["2.1.268", "2.1.269", "2.1.300", "2.2.0", "2.99.0"] {
        assert!(version_admitted(admitted), "{admitted} should be admitted");
    }
    for rejected in [
        "2.1.267",
        "2.0.9",
        "1.9.9",
        "3.0.0",
        "10.1.268",
        "2.1",
        "2.1.268.1",
        "2.1.x",
        "v2.1.268",
        "2.1.268-beta",
        "",
        "9999999999.1.1",
    ] {
        assert!(!version_admitted(rejected), "{rejected} should be rejected");
    }
}
