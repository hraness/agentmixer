use crate::{
    Error, Result, private,
    process::{Pin, capture, environment},
    store::Store,
};
use regex::Regex;
use std::{path::Path, sync::OnceLock, time::Duration};
use tokio::process::Command;
use xcb_core::{Id, Provider};
use zeroize::Zeroizing;

pub fn valid_token(text: &str) -> bool {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            Regex::new(r"^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,1024}$").expect("static token shape")
        })
        .is_match(text)
}

pub fn store_token(store: &Store, id: &Id, bytes: &[u8]) -> Result<()> {
    if store.account(id)?.provider != Provider::Claude {
        return Err(Error::Unavailable(
            "token input is only supported for Claude",
        ));
    }
    let token = std::str::from_utf8(bytes)
        .map_err(|_| Error::Unavailable("invalid token"))?
        .trim();
    if !valid_token(token) {
        return Err(Error::Unavailable("invalid subscription token"));
    }
    private::create(
        &store.account_root(id)?.join("subscription-token"),
        token.as_bytes(),
    )
}

pub(crate) fn token(store: &Store, id: &Id) -> Result<Zeroizing<String>> {
    let bytes = Zeroizing::new(private::read(
        &store.account_root(id)?.join("subscription-token"),
        2048,
    )?);
    let token = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Unavailable("invalid stored credential"))?
        .trim();
    if !valid_token(token) {
        return Err(Error::Unavailable(
            "no valid stored token; use xcb accounts login",
        ));
    }
    Ok(Zeroizing::new(token.to_owned()))
}

pub fn has_token(store: &Store, id: &Id) -> Result<bool> {
    let path = store.account_root(id)?.join("subscription-token");
    match private::read(&path, 2048) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            Ok(std::str::from_utf8(&bytes).is_ok_and(|text| valid_token(text.trim())))
        }
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub async fn login(store: &Store, id: &Id, pin: &Pin) -> Result<()> {
    let account = store.account(id)?;
    if account.provider != pin.provider {
        return Err(Error::Conflict("login provider mismatch"));
    }
    pin.verify()?;
    let root = store.account_root(id)?;
    let home = private::directory(&root.join("home"))?;
    private::directory(&home.join("tmp"))?;
    let mut env = environment(&home);
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        root.join("profile").to_string_lossy().into_owned(),
    );
    env.insert(
        "CODEX_HOME".into(),
        root.join("profile").to_string_lossy().into_owned(),
    );
    let mut command = Command::new(&pin.executable);
    command.env_clear().envs(env).current_dir(&home);
    match account.provider {
        Provider::Claude => {
            command.arg("setup-token");
            let bytes =
                Zeroizing::new(capture(command, 64 * 1024, Duration::from_secs(600)).await?);
            let output = std::str::from_utf8(&bytes)
                .map_err(|_| Error::Protocol("login output encoding"))?;
            let ansi = Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]").expect("static ANSI pattern");
            let cleaned = Zeroizing::new(ansi.replace_all(output, "").into_owned());
            let pattern = Regex::new(
                r"sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+(?:\n[ \t]*[A-Za-z0-9_-]{40,}[ \t]*)*",
            )
            .expect("static token capture");
            let found = pattern.find(&cleaned).ok_or(Error::Unavailable(
                "sign-in did not return a subscription token",
            ))?;
            let value = Zeroizing::new(
                found
                    .as_str()
                    .chars()
                    .filter(|ch| !ch.is_whitespace())
                    .collect::<String>(),
            );
            store_token(store, id, value.as_bytes())
        }
        Provider::Devin => {
            command.args(["auth", "login"]);
            capture(command, 64 * 1024, Duration::from_secs(600)).await?;
            Ok(())
        }
        Provider::Codex => {
            command.args([
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "login",
                "--device-auth",
            ]);
            capture(command, 64 * 1024, Duration::from_secs(600)).await?;
            Ok(())
        }
    }
}

pub fn import_agentmixer_token(store: &Store, source: &Path, name: &str) -> Result<Id> {
    private::check_directory(source)?;
    let bytes = Zeroizing::new(private::read(&source.join("claude-oauth-token"), 2048)?);
    if !std::str::from_utf8(&bytes).is_ok_and(|text| valid_token(text.trim())) {
        return Err(Error::Unavailable(
            "legacy subscription token is missing or invalid",
        ));
    }
    let account = store.add_account(
        Provider::Claude,
        name,
        "Imported subscription",
        crate::now_ms(),
    )?;
    store_token(store, &account.id, &bytes)?;
    Ok(account.id)
}
