use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    session::{Message, MessageProvenance, Role},
};

fn model() -> ModelChoice {
    ModelChoice {
        provider: Provider::Claude,
        id: Id::new("claude-fable-5-1").unwrap(),
        label: "Fable 5.1".into(),
        mode: Mode::Fixed,
        resolved: None,
        effort: None,
        observed_at_ms: 1,
    }
}

#[test]
fn legacy_messages_roundtrip_with_none_provenance() {
    let json = r#"{"id":"m1","role":"user","text":"hello","at_ms":1}"#;
    let message: Message = serde_json::from_str(json).unwrap();
    assert!(message.provenance.is_none());
    assert!(message.validate().is_ok());
    let round = serde_json::to_string(&message).unwrap();
    assert!(!round.contains("provenance"));
}

#[test]
fn provenanced_messages_roundtrip_and_validate() {
    let provenance = MessageProvenance {
        account: Id::new("personal").unwrap(),
        model: model(),
        run: Some(Id::new("r1").unwrap()),
    };
    let message = Message {
        id: Id::new("m1").unwrap(),
        role: Role::Assistant,
        text: "result".into(),
        at_ms: 1,
        attachments: vec![],
        provenance: Some(provenance),
    };
    assert!(message.validate().is_ok());
    let round: Message = serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();
    assert!(round.provenance.is_some());
    assert_eq!(round.provenance.unwrap().account.as_str(), "personal");
}

#[test]
fn provenance_boundary_label_prefers_provider_model_run() {
    let first = MessageProvenance {
        account: Id::new("personal").unwrap(),
        model: model(),
        run: None,
    };
    let second = MessageProvenance {
        account: Id::new("personal").unwrap(),
        model: model(),
        run: Some(Id::new("r1").unwrap()),
    };
    let third = MessageProvenance {
        account: Id::new("work").unwrap(),
        model: model(),
        run: Some(Id::new("r1").unwrap()),
    };
    assert!(!first.boundary_label(None).contains("personal"));
    assert!(first.boundary_label(None).contains("claude"));
    assert!(second.boundary_label(Some(&first)).contains("r1"));
    assert!(!second.boundary_label(Some(&first)).contains("personal"));
    assert!(third.boundary_label(Some(&second)).contains("↷"));
    assert!(!third.boundary_label(Some(&second)).contains("work"));
    assert!(second.boundary_label(Some(&second)).is_empty());
}
