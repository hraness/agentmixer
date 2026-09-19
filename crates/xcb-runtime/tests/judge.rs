use std::collections::BTreeMap;
use xcb_runtime::{
    jev::{Endpoint, SYSTEM_ONE_URL, parse_response},
    judge::{
        self, JudgeAnswer, JudgeKeySource, JudgeQuestion, JudgeQuestions, MAX_JUDGE_QUESTIONS,
    },
    store::Store,
};

fn root() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn noul(instructions: &str) -> JudgeQuestion {
    JudgeQuestion::Noul {
        instructions: instructions.to_owned(),
        criteria: None,
    }
}

#[test]
fn endpoint_parsing_accepts_https_only() {
    let endpoint = Endpoint::parse(SYSTEM_ONE_URL).unwrap();
    assert_eq!(endpoint.host, "api.typesafe.ai");
    assert_eq!(endpoint.port, 443);
    assert_eq!(endpoint.path, "/v1/systemone");
    assert_eq!(endpoint.authority(), "api.typesafe.ai");

    let with_port = Endpoint::parse("https://judge.internal:8443/ask").unwrap();
    assert_eq!(with_port.host, "judge.internal");
    assert_eq!(with_port.port, 8443);
    assert_eq!(with_port.path, "/ask");
    assert_eq!(with_port.authority(), "judge.internal:8443");

    for url in [
        "http://api.typesafe.ai/v1/systemone",
        "https://",
        "https://:443/x",
        "https://user@host/x",
        "https://host/x?q=1",
        "https://host/x#frag",
        "https://host/x y",
        "https://host:notaport/x",
        "",
    ] {
        assert!(Endpoint::parse(url).is_err(), "{url} must be rejected");
    }
}

#[test]
fn question_batches_are_bounded() {
    let mut questions = JudgeQuestions::new();
    assert!(judge::check_questions(&questions).is_err(), "empty batch");
    questions.insert("q".to_owned(), noul("keep?"));
    judge::check_questions(&questions).unwrap();

    questions.insert("bad name!".to_owned(), noul("x"));
    assert!(judge::check_questions(&questions).is_err());
    questions.remove("bad name!");
    questions.insert("long".to_owned(), noul(&"x".repeat(5000)));
    assert!(judge::check_questions(&questions).is_err());
    questions.remove("long");

    let mut many = JudgeQuestions::new();
    for index in 0..=MAX_JUDGE_QUESTIONS {
        many.insert(format!("q{index}"), noul("x"));
    }
    assert!(judge::check_questions(&many).is_err(), "over-limit batch");

    let mut choices = JudgeQuestions::new();
    choices.insert(
        "pick".to_owned(),
        JudgeQuestion::Choice {
            instructions: "choose".to_owned(),
            criteria: BTreeMap::new(),
        },
    );
    assert!(judge::check_questions(&choices).is_err(), "empty options");

    let state = serde_json::json!({"task": "x".repeat(200 * 1024)});
    assert!(judge::check_state(&state).is_err(), "oversized state");
    judge::check_state(&serde_json::json!({"task": "small"})).unwrap();
}

#[test]
fn response_parsing_validates_each_answer_shape() {
    let answers = parse_response(
        200,
        br#"{"model":"jev-latest","answers":{"k":{"noul":0.7},"r":{"choice":"route_1","confidence":0.9,"probabilities":{"route_1":0.9,"route_0":0.1}},"s":{"score":4.0,"confidence":0.8,"probabilities":{"4":0.5}}}}"#,
    )
    .unwrap();
    assert_eq!(answers.model.as_deref(), Some("jev-latest"));
    assert_eq!(answers.answers["k"].noul(), Some(0.7));
    assert_eq!(answers.answers["r"].choice(), Some(("route_1", 0.9)));
    assert_eq!(answers.answers["s"].score(), Some((4.0, 0.8)));

    assert!(matches!(answers.answers["k"], JudgeAnswer::Noul(_)));
    let questions = BTreeMap::from([
        ("k".to_owned(), noul("yes?")),
        (
            "r".to_owned(),
            JudgeQuestion::Choice {
                instructions: "route".to_owned(),
                criteria: BTreeMap::from([
                    ("route_0".to_owned(), None),
                    ("route_1".to_owned(), None),
                ]),
            },
        ),
        (
            "s".to_owned(),
            JudgeQuestion::Score {
                instructions: "score".to_owned(),
                criteria: (0..5).map(|index| index.to_string()).collect(),
            },
        ),
    ]);
    judge::check_answers(&questions, &answers).unwrap();
    let mut incomplete = answers.clone();
    incomplete.answers.remove("k");
    assert!(judge::check_answers(&questions, &incomplete).is_err());
    let mut wrong_options = questions.clone();
    if let JudgeQuestion::Choice { criteria, .. } = wrong_options.get_mut("r").unwrap() {
        criteria.remove("route_1");
    }
    assert!(judge::check_answers(&wrong_options, &answers).is_err());
    let mut missing_selected_probability = answers.clone();
    if let JudgeAnswer::Choice { probabilities, .. } =
        missing_selected_probability.answers.get_mut("r").unwrap()
    {
        probabilities.remove("route_1");
    }
    assert!(judge::check_answers(&questions, &missing_selected_probability).is_err());
    let mut short_scale = questions.clone();
    if let JudgeQuestion::Score { criteria, .. } = short_scale.get_mut("s").unwrap() {
        criteria.pop();
    }
    assert!(judge::check_answers(&short_scale, &answers).is_err());

    for body in [
        br#"not json"#.as_slice(),
        br#"{"answers":{}}"#.as_slice(),
        br#"{"answers":{"k":{"noul":1.5}}}"#.as_slice(),
        br#"{"answers":{"k":{"noul":"x"}}}"#.as_slice(),
        br#"{"answers":{"k":{}}}"#.as_slice(),
        br#"{"answers":{"k":{"choice":"r"}}}"#.as_slice(),
        br#"{"model":"jev-latest\nforged","answers":{"k":{"noul":0.5}}}"#.as_slice(),
        br#"{"answers":{"k":{"choice":"route_0\nforged","confidence":0.5,"probabilities":{"route_0":1.0}}}}"#.as_slice(),
        br#"{"answers":{"k":{"choice":"route_0","confidence":1.1,"probabilities":{"route_0":1.0}}}}"#.as_slice(),
        br#"{"answers":{"k":{"choice":"route_0","confidence":0.5,"probabilities":{"route_0":-0.1}}}}"#.as_slice(),
        br#"{"answers":{"k":{"noul":0.5,"choice":"route_0"}}}"#.as_slice(),
        br#"{"answers":{"k":{"score":"x","confidence":0.5,"probabilities":{}}}}"#.as_slice(),
    ] {
        assert!(parse_response(200, body).is_err(), "{body:?} must fail");
    }
    for status in [401, 429, 500] {
        assert!(parse_response(status, b"{}").is_err());
    }
}

#[test]
fn vault_key_custody_roundtrips_without_echo() {
    let root = root();
    let store = Store::open(&root.path().canonicalize().unwrap().join("state")).unwrap();
    assert!(!judge::has_judge_token(store.root()).unwrap());
    judge::store_judge_token(store.root(), b"ts_test_key-123.abc=\n").unwrap();
    assert!(judge::has_judge_token(store.root()).unwrap());
    assert!(
        judge::store_judge_token(store.root(), b"ts_other").is_err(),
        "no-clobber: a second key must not overwrite"
    );
    if std::env::var_os(judge::JUDGE_KEY_ENV).is_none()
        && std::env::var_os(judge::JUDGE_KEY_VENDOR_ENV).is_none()
    {
        let (token, source) = judge::judge_token(store.root()).unwrap().unwrap();
        assert_eq!(token.as_str(), "ts_test_key-123.abc=");
        assert_eq!(source, JudgeKeySource::Vault);
    }
    for bad in ["", "has space", "key\nwith\nlines", &"x".repeat(600)] {
        assert!(judge::store_judge_token(store.root(), bad.as_bytes()).is_err());
    }
    assert!(judge::remove_judge_token(store.root()).unwrap());
    assert!(!judge::remove_judge_token(store.root()).unwrap());
}
