use xcb_runtime::{config::Config, private};

#[test]
fn useful_local_extensions_default_on_and_publishing_defaults_off() {
    let config = Config::default();
    config.validate().unwrap();
    assert!(config.extensions.auto_continue.enabled);
    assert!(config.extensions.gobstopper.enabled);
    assert_eq!(config.extensions.gobstopper.min_savings_tokens, 4_096);
    let mut invalid = config.clone();
    invalid.extensions.gobstopper.min_savings_tokens = 250_001;
    assert!(invalid.validate().is_err());
    assert!(config.extensions.usage);
    assert!(!config.extensions.aicharts_upload);
    assert!(!config.extensions.aicharts_export);
    assert!(!config.extensions.hooks);
}

#[test]
fn config_changes_are_revision_guarded_and_unknown_keys_refuse() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("state");
    private::directory(&path).unwrap();
    let (mut config, revision) = Config::load(&path).unwrap();
    assert!(revision.is_none());
    config.save(&path, None).unwrap();
    assert!(config.save(&path, None).is_err());
    let (_, revision) = Config::load(&path).unwrap();
    config.extensions.auto_continue.enabled = false;
    config.save(&path, revision.as_deref()).unwrap();
    assert!(config.save(&path, revision.as_deref()).is_err());
    assert!(
        !Config::load(&path)
            .unwrap()
            .0
            .extensions
            .auto_continue
            .enabled
    );
    assert!(serde_json::from_str::<Config>(r#"{"exec":"sh"}"#).is_err());
}

#[test]
fn concurrent_config_writers_cannot_both_replace_the_same_revision() {
    let directory = tempfile::tempdir().unwrap();
    let root = private::directory(&directory.path().canonicalize().unwrap().join("state")).unwrap();
    for round in 0..12 {
        let path = root.join(format!("settings-{round}.json"));
        private::create(&path, b"original").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(20));
        let writers: Vec<_> = (0..20)
            .map(|index| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let expected = xcb_runtime::digest(b"original");
                    barrier.wait();
                    private::replace(&path, format!("writer-{index}").as_bytes(), &expected).is_ok()
                })
            })
            .collect();
        let succeeded = writers
            .into_iter()
            .map(|writer| usize::from(writer.join().unwrap()))
            .sum::<usize>();
        assert_eq!(succeeded, 1, "multiple commits to revision {round}");
    }
}
