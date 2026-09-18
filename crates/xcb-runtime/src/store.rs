use crate::{Error, Result, digest, new_id, private};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use xcb_core::{
    Id, Provider, label,
    models::ModelChoice,
    session::{Message, Session, State},
    usage::{Counters, QuotaPoint},
};

const MAX_ACCOUNTS: i64 = 128;
const MAX_SESSIONS: i64 = 10_000;
const MAX_MESSAGES: i64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub id: Id,
    pub provider: Provider,
    pub label: String,
    pub subscription: String,
    pub quota_pool: Id,
    pub enabled: bool,
    pub created_at_ms: u64,
}
impl Account {
    pub fn validate(&self) -> Result<()> {
        label(&self.label, 80)?;
        label(&self.subscription, 80)?;
        Ok(())
    }
}

/// Identity of the xcb process instance that owns a run. Persisted on the run
/// row so sibling terminals can tell "working in another terminal" apart from
/// a genuinely unsettled run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunOwner {
    pub instance: String,
    pub pid: u32,
}
impl RunOwner {
    /// True while the recorded owning process still exists. A signal-permission
    /// failure also proves presence; only an absent or invalid pid does not.
    pub fn alive(&self) -> bool {
        let Some(pid) = i32::try_from(self.pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        matches!(
            rustix::process::test_kill_process(pid),
            Ok(()) | Err(rustix::io::Errno::PERM)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRecord {
    pub id: Id,
    pub session: Option<Id>,
    pub account: Id,
    pub revision: u64,
    pub phase: String,
    pub pid: Option<u32>,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<RunOwner>,
}

impl RunRecord {
    pub fn validate(&self) -> Result<()> {
        if let Some(model) = &self.model {
            model.validate()?;
        }
        if self
            .owner
            .as_ref()
            .is_some_and(|owner| owner.instance.is_empty() || owner.instance.len() > 160)
        {
            return Err(xcb_core::Error::Invalid("run owner").into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageObservation {
    pub id: Id,
    pub session: Id,
    pub account: Id,
    pub model: ModelChoice,
    pub counters: Counters,
    pub at_ms: u64,
}

pub struct Store {
    root: PathBuf,
    /// Unique identity of this open handle — one per terminal process — stamped
    /// on every run this store prepares so other terminals can recognise
    /// foreign-owned live runs.
    instance: String,
    connection: Mutex<Connection>,
}

fn decode<T: DeserializeOwned>(text: &str) -> Result<T> {
    if text.len() > 1024 * 1024 {
        return Err(xcb_core::Error::Limit("stored record").into());
    }
    Ok(serde_json::from_str(text)?)
}
fn session_from(connection: &Connection, id: &Id) -> Result<Option<Session>> {
    let json: Option<String> = connection
        .query_row(
            "SELECT payload FROM sessions WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| {
        let session: Session = decode(&json)?;
        session.validate()?;
        Ok(session)
    })
    .transpose()
}
fn sql(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| xcb_core::Error::Invalid("database integer").into())
}

fn update_session(transaction: &Transaction<'_>, session: &Session, expected: u64) -> Result<()> {
    session.validate()?;
    if transaction.execute(
        "UPDATE sessions SET payload=?1, revision=?2, last_active=?3 WHERE id=?4 AND revision=?5",
        params![
            serde_json::to_string(session)?,
            sql(session.revision)?,
            sql(session.last_active_at_ms)?,
            session.id.as_str(),
            sql(expected)?
        ],
    )? != 1
    {
        return Err(Error::Conflict("session revision changed"));
    }
    Ok(())
}

impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        let root = private::directory(root)?;
        let lock_path = root.join(".initialize.lock");
        let initialization = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK
                    | rustix::fs::OFlags::CLOEXEC)
                    .bits() as i32,
            )
            .open(&lock_path)?;
        private::check_file(&initialization, 0)?;
        private::lock(&initialization)?;
        private::same_file(&lock_path, &initialization)?;
        for name in [
            "accounts",
            "panes",
            "hooks",
            "runs",
            "attachments",
            "exports",
        ] {
            private::directory(&root.join(name))?;
        }
        let path = root.join("xcb.sqlite");
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                private::open_file(&path, 8 * 1024 * 1024 * 1024)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                private::create(&path, &[])?;
            }
            Err(error) => return Err(error.into()),
        }
        for suffix in ["xcb.sqlite-wal", "xcb.sqlite-shm", "xcb.sqlite-journal"] {
            // SQLite retires these sidecars when the last connection closes;
            // a sibling store can legitimately unlink one after this process
            // releases the initialization lock but before it exits.
            private::open_file_maybe_vanished(&root.join(suffix), 1024 * 1024 * 1024)?;
        }
        let mut connection = Connection::open(&path)?;
        // Writers serialize on the WAL writer lock; readers never block.
        // Twenty parallel terminals × short transactions still fit well under
        // this bound on a loaded host, and a dead process's locks are released
        // by the kernel, so a generous ceiling cannot deadlock the store.
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let journal: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal.eq_ignore_ascii_case("wal") {
            connection.pragma_update(None, "journal_mode", "WAL")?;
        }
        connection.pragma_update(None, "synchronous", "FULL")?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err(Error::Unavailable("database was written by a newer xcb"));
        }
        if version == 0 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
            if current > 1 {
                return Err(Error::Unavailable("database was written by a newer xcb"));
            }
            if current == 0 {
                tx.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE sessions(id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), payload TEXT NOT NULL, revision INTEGER NOT NULL, last_active INTEGER NOT NULL);
                CREATE INDEX sessions_activity ON sessions(last_active DESC, id);
                CREATE TABLE messages(id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(session, sequence));
                CREATE TABLE runs(id TEXT PRIMARY KEY, session TEXT REFERENCES sessions(id) ON DELETE CASCADE, account TEXT NOT NULL REFERENCES accounts(id), phase TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE leases(account TEXT PRIMARY KEY REFERENCES accounts(id), run TEXT NOT NULL UNIQUE REFERENCES runs(id));
                CREATE TABLE usage(id TEXT PRIMARY KEY, session TEXT NOT NULL, account TEXT NOT NULL, observed_at INTEGER NOT NULL, payload TEXT NOT NULL);
                CREATE INDEX usage_activity ON usage(session, observed_at DESC);
                CREATE TABLE quotas(pool TEXT NOT NULL, window TEXT NOT NULL, observed_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(pool, window, observed_at));
                CREATE TABLE models(provider TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(provider, id));
                CREATE TABLE tool_effects(run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, call TEXT NOT NULL, operation TEXT NOT NULL, input_digest TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run,call));
                CREATE TABLE velocity(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, at_ms INTEGER NOT NULL, output_total INTEGER NOT NULL, PRIMARY KEY(session,at_ms));
                PRAGMA user_version=1;")?;
            }
            tx.commit()?;
        }
        Ok(Self {
            root,
            instance: new_id("i").to_string(),
            connection: Mutex::new(connection),
        })
    }
    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| Error::Conflict("database lock poisoned"))
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// The identity this handle stamps on runs it prepares.
    pub fn instance(&self) -> &str {
        &self.instance
    }
    fn owner(&self) -> RunOwner {
        RunOwner {
            instance: self.instance.clone(),
            pid: std::process::id(),
        }
    }
    /// True when `session` has an unsettled run owned by a different — still
    /// living — process instance. Such a run is active work in another
    /// terminal, not a run needing recovery.
    pub fn remote_active(&self, session: &Id) -> Result<bool> {
        Ok(self.unsettled_runs()?.iter().any(|run| {
            run.session.as_ref() == Some(session)
                && run
                    .owner
                    .as_ref()
                    .is_some_and(|owner| owner.instance != self.instance && owner.alive())
        }))
    }

    pub fn add_account(
        &self,
        provider: Provider,
        name: &str,
        subscription: &str,
        now: u64,
    ) -> Result<Account> {
        label(name, 80)?;
        label(subscription, 80)?;
        let id = new_id("a");
        let account = Account {
            quota_pool: id.clone(),
            id,
            provider,
            label: name.to_owned(),
            subscription: subscription.to_owned(),
            enabled: true,
            created_at_ms: now,
        };
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT count(*) FROM accounts", [], |row| row.get(0))?;
        if count >= MAX_ACCOUNTS {
            return Err(xcb_core::Error::Limit("accounts").into());
        }
        tx.execute(
            "INSERT INTO accounts(id,payload) VALUES(?1,?2)",
            params![account.id.as_str(), serde_json::to_string(&account)?],
        )?;
        let root = private::directory(&self.root.join("accounts").join(account.id.as_str()))?;
        for name in ["profile", "home"] {
            private::directory(&root.join(name))?;
        }
        tx.commit()?;
        Ok(account)
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let db = self.db()?;
        let mut query = db.prepare("SELECT payload FROM accounts ORDER BY id LIMIT 129")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut accounts = Vec::new();
        for row in rows {
            let account: Account = decode(&row?)?;
            account.validate()?;
            accounts.push(account);
        }
        if accounts.len() > MAX_ACCOUNTS as usize {
            return Err(xcb_core::Error::Limit("accounts").into());
        }
        Ok(accounts)
    }
    pub fn account(&self, id: &Id) -> Result<Account> {
        self.accounts()?
            .into_iter()
            .find(|account| &account.id == id)
            .ok_or(Error::Unavailable("account not found"))
    }
    pub fn resolve_account(&self, value: &str) -> Result<Account> {
        let matches: Vec<_> = self
            .accounts()?
            .into_iter()
            .filter(|account| account.id.as_str() == value || account.label == value)
            .collect();
        if matches.len() != 1 {
            return Err(Error::Unavailable(
                "account not found or label is ambiguous; use its id",
            ));
        }
        Ok(matches.into_iter().next().expect("one account"))
    }
    pub fn account_root(&self, id: &Id) -> Result<PathBuf> {
        self.account(id)?;
        private::check_directory(&self.root.join("accounts").join(id.as_str()))
    }
    pub fn set_account_enabled(&self, id: &Id, enabled: bool) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1)",
            [id.as_str()],
            |row| row.get(0),
        )?;
        if held {
            return Err(Error::Conflict("account has an unsettled run"));
        }
        let json: String = tx.query_row(
            "SELECT payload FROM accounts WHERE id=?1",
            [id.as_str()],
            |row| row.get(0),
        )?;
        let mut account: Account = decode(&json)?;
        account.enabled = enabled;
        account.validate()?;
        tx.execute(
            "UPDATE accounts SET payload=?1 WHERE id=?2",
            params![serde_json::to_string(&account)?, id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn create_session(
        &self,
        account_id: &Id,
        model: ModelChoice,
        workspace: &Path,
        now: u64,
    ) -> Result<Session> {
        let account = self.account(account_id)?;
        model.validate()?;
        let workspace = workspace.canonicalize()?;
        if !workspace.is_dir()
            || workspace.starts_with(&self.root)
            || self.root.starts_with(&workspace)
            || model.provider != account.provider
            || !account.enabled
        {
            return Err(Error::Conflict("account or workspace unavailable"));
        }
        let session = Session {
            id: new_id("s"),
            account: account_id.clone(),
            model,
            workspace: workspace.to_str().ok_or(Error::PrivateState)?.to_owned(),
            title: "New session".into(),
            pane: Id::new("focus")?,
            state: State::Idle,
            revision: 0,
            created_at_ms: now,
            last_active_at_ms: now,
        };
        session.validate()?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))?;
        if count >= MAX_SESSIONS {
            return Err(xcb_core::Error::Limit("sessions; prune old sessions").into());
        }
        tx.execute(
            "INSERT INTO sessions VALUES(?1,?2,?3,?4,?5)",
            params![
                session.id.as_str(),
                account_id.as_str(),
                serde_json::to_string(&session)?,
                sql(session.revision)?,
                sql(now)?
            ],
        )?;
        tx.commit()?;
        Ok(session)
    }
    pub fn session(&self, id: &Id) -> Result<Option<Session>> {
        let db = self.db()?;
        session_from(&db, id)
    }
    pub fn sessions(&self, limit: usize) -> Result<Vec<Session>> {
        if !(1..=256).contains(&limit) {
            return Err(xcb_core::Error::Invalid("session page limit").into());
        }
        let db = self.db()?;
        let mut query =
            db.prepare("SELECT payload FROM sessions ORDER BY last_active DESC,id LIMIT ?1")?;
        let rows = query.query_map([limit as i64], |row| row.get::<_, String>(0))?;
        let mut sessions = Vec::new();
        for row in rows {
            let session: Session = decode(&row?)?;
            session.validate()?;
            sessions.push(session);
        }
        Ok(sessions)
    }
    pub fn append_message(
        &self,
        id: &Id,
        expected_revision: u64,
        message: &Message,
    ) -> Result<Session> {
        message.validate()?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut session = session_from(&tx, id)?.ok_or(Error::Unavailable("session not found"))?;
        if session.revision != expected_revision {
            return Err(Error::Conflict("session revision changed"));
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM messages WHERE session=?1",
            [id.as_str()],
            |row| row.get(0),
        )?;
        if count >= MAX_MESSAGES {
            return Err(xcb_core::Error::Limit("session messages").into());
        }
        tx.execute(
            "INSERT INTO messages VALUES(?1,?2,?3,?4)",
            params![
                message.id.as_str(),
                id.as_str(),
                count + 1,
                serde_json::to_string(message)?
            ],
        )?;
        session.revision = session
            .revision
            .checked_add(1)
            .ok_or(Error::Conflict("revision overflow"))?;
        session.last_active_at_ms = session.last_active_at_ms.max(message.at_ms);
        if session.title == "New session" && message.role == xcb_core::session::Role::User {
            session.title = message
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
            if session.title.is_empty() {
                session.title = "Image message".into();
            }
        }
        update_session(&tx, &session, expected_revision)?;
        tx.commit()?;
        Ok(session)
    }
    pub fn messages(&self, id: &Id, limit: usize) -> Result<Vec<Message>> {
        if !(1..=512).contains(&limit) {
            return Err(xcb_core::Error::Invalid("message page limit").into());
        }
        let db = self.db()?;
        let mut query = db.prepare("SELECT payload FROM (SELECT sequence,payload FROM messages WHERE session=?1 ORDER BY sequence DESC LIMIT ?2) ORDER BY sequence")?;
        let rows = query.query_map(params![id.as_str(), limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut messages = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            let row = row?;
            bytes += row.len();
            if bytes > 8 * 1024 * 1024 {
                return Err(xcb_core::Error::Limit("transcript page").into());
            }
            let message: Message = decode(&row)?;
            message.validate()?;
            messages.push(message);
        }
        Ok(messages)
    }
    pub fn prepare_run(
        &self,
        session_id: &Id,
        expected_revision: u64,
        now: u64,
    ) -> Result<RunRecord> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut session =
            session_from(&tx, session_id)?.ok_or(Error::Unavailable("session not found"))?;
        if session.revision != expected_revision {
            return Err(Error::Conflict("session revision changed"));
        }
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1)",
            [session.account.as_str()],
            |row| row.get(0),
        )?;
        if held {
            return Err(Error::Conflict(
                "account has an unsettled run; time alone cannot release custody",
            ));
        }
        let account_json: String = tx.query_row(
            "SELECT payload FROM accounts WHERE id=?1",
            [session.account.as_str()],
            |row| row.get(0),
        )?;
        let account: Account = decode(&account_json)?;
        if !account.enabled {
            return Err(Error::Conflict("account is disabled"));
        }
        session.revision = session
            .revision
            .checked_add(1)
            .ok_or(Error::Conflict("revision overflow"))?;
        session.state = State::Working;
        session.last_active_at_ms = session.last_active_at_ms.max(now);
        let run = RunRecord {
            id: new_id("r"),
            session: Some(session_id.clone()),
            account: session.account.clone(),
            revision: session.revision,
            phase: "prepared".into(),
            pid: None,
            created_at_ms: now,
            model: Some(session.model.clone()),
            owner: Some(self.owner()),
        };
        tx.execute(
            "INSERT INTO runs VALUES(?1,?2,?3,?4,?5)",
            params![
                run.id.as_str(),
                session_id.as_str(),
                session.account.as_str(),
                run.phase,
                serde_json::to_string(&run)?
            ],
        )?;
        tx.execute(
            "INSERT INTO leases VALUES(?1,?2)",
            params![session.account.as_str(), run.id.as_str()],
        )?;
        update_session(&tx, &session, expected_revision)?;
        tx.commit()?;
        Ok(run)
    }
    pub(crate) fn prepare_probe(
        &self,
        account: &Id,
        model: Option<ModelChoice>,
        now: u64,
    ) -> Result<RunRecord> {
        let target = self.account(account)?;
        if !target.enabled {
            return Err(Error::Conflict("account is disabled"));
        }
        if let Some(model) = &model {
            model.validate()?;
            if model.provider != target.provider {
                return Err(Error::Conflict("probe model provider mismatch"));
            }
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1)",
            [account.as_str()],
            |row| row.get(0),
        )?;
        if held {
            return Err(Error::Conflict("account has an unsettled run"));
        }
        let run = RunRecord {
            id: new_id("probe"),
            session: None,
            account: account.clone(),
            revision: 0,
            phase: "prepared".into(),
            pid: None,
            created_at_ms: now,
            model,
            owner: Some(self.owner()),
        };
        tx.execute(
            "INSERT INTO runs VALUES(?1,NULL,?2,'prepared',?3)",
            params![
                run.id.as_str(),
                account.as_str(),
                serde_json::to_string(&run)?
            ],
        )?;
        tx.execute(
            "INSERT INTO leases VALUES(?1,?2)",
            params![account.as_str(), run.id.as_str()],
        )?;
        tx.commit()?;
        Ok(run)
    }
    pub(crate) fn mark_spawned(&self, run: &RunRecord, pid: u32) -> Result<RunRecord> {
        let next = RunRecord {
            phase: "running".into(),
            pid: Some(pid),
            ..run.clone()
        };
        if self.db()?.execute("UPDATE runs SET phase='running',payload=?1 WHERE id=?2 AND phase='prepared' AND EXISTS(SELECT 1 FROM leases WHERE account=?3 AND run=?2)", params![serde_json::to_string(&next)?, run.id.as_str(), run.account.as_str()])? != 1 { return Err(Error::Conflict("run authority changed")); }
        Ok(next)
    }
    pub(crate) fn settle(&self, run: &RunRecord, state: State, now: u64) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1 AND run=?2)",
            params![run.account.as_str(), run.id.as_str()],
            |row| row.get(0),
        )?;
        if !held {
            return Err(Error::Conflict("run authority changed"));
        }
        if let Some(id) = &run.session {
            let mut session =
                session_from(&tx, id)?.ok_or(Error::Unavailable("session not found"))?;
            let expected = session.revision;
            session.revision = expected
                .checked_add(1)
                .ok_or(Error::Conflict("revision overflow"))?;
            session.state = state;
            session.last_active_at_ms = session.last_active_at_ms.max(now);
            update_session(&tx, &session, expected)?;
        }
        let record = RunRecord {
            phase: "settled".into(),
            ..run.clone()
        };
        tx.execute(
            "UPDATE runs SET phase='settled',payload=?1 WHERE id=?2",
            params![serde_json::to_string(&record)?, run.id.as_str()],
        )?;
        tx.execute(
            "DELETE FROM leases WHERE account=?1 AND run=?2",
            params![run.account.as_str(), run.id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn unsettled_runs(&self) -> Result<Vec<RunRecord>> {
        let db = self.db()?;
        let mut query =
            db.prepare("SELECT payload FROM runs WHERE phase!='settled' ORDER BY id LIMIT 129")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut runs = Vec::new();
        for row in rows {
            let run: RunRecord = decode(&row?)?;
            run.validate()?;
            runs.push(run);
        }
        Ok(runs)
    }
    pub fn run(&self, id: &Id) -> Result<Option<RunRecord>> {
        self.recovery_candidate(id)
            .map(|candidate| candidate.map(|(run, _)| run))
    }
    pub fn recovery_candidate(&self, id: &Id) -> Result<Option<(RunRecord, String)>> {
        let db = self.db()?;
        let payload: Option<String> = db
            .query_row(
                "SELECT payload FROM runs WHERE id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|payload| {
                let payload_digest = digest(payload.as_bytes());
                let run: RunRecord = decode(&payload)?;
                run.validate()?;
                Ok((run, payload_digest))
            })
            .transpose()
    }
    pub fn recover_run(&self, run_id: &Id, expected_digest: &str, now: u64) -> Result<RunRecord> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let payload: String = tx
            .query_row(
                "SELECT payload FROM runs WHERE id=?1",
                [run_id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::Unavailable("run not found"))?;
        let run: RunRecord = decode(&payload)?;
        run.validate()?;
        if run.phase != "running" {
            return Err(Error::Conflict("run is not in running phase"));
        }
        let Some(pid) = run.pid else {
            return Err(Error::Conflict("run has no recorded process group"));
        };
        if pid == 0 {
            return Err(Error::Conflict("recorded process group id must be nonzero"));
        }
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1 AND run=?2)",
            params![run.account.as_str(), run_id.as_str()],
            |row| row.get(0),
        )?;
        if !held {
            return Err(Error::Conflict("run lease is absent"));
        }
        if digest(payload.as_bytes()) != expected_digest {
            return Err(Error::Conflict("run changed since process-group proof"));
        }
        if let Some(session_id) = &run.session {
            let mut session =
                session_from(&tx, session_id)?.ok_or(Error::Unavailable("session not found"))?;
            let expected_revision = session.revision;
            session.revision = expected_revision
                .checked_add(1)
                .ok_or(Error::Conflict("revision overflow"))?;
            session.state = State::Uncertain;
            session.last_active_at_ms = session.last_active_at_ms.max(now);
            update_session(&tx, &session, expected_revision)?;
        }
        let settled = RunRecord {
            phase: "settled".into(),
            ..run.clone()
        };
        if tx.execute(
            "UPDATE runs SET phase='settled', payload=?1 WHERE id=?2 AND account=?3 AND phase='running' AND payload=?4",
            params![
                serde_json::to_string(&settled)?,
                run_id.as_str(),
                run.account.as_str(),
                payload
            ],
        )? != 1
        {
            return Err(Error::Conflict("run no longer matches recovery proof"));
        }
        if tx.execute(
            "DELETE FROM leases WHERE account=?1 AND run=?2",
            params![run.account.as_str(), run_id.as_str()],
        )? != 1
        {
            return Err(Error::Conflict("lease changed during recovery"));
        }
        tx.commit()?;
        Ok(settled)
    }
    pub fn remove_session(&self, id: &Id) -> Result<bool> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE session=?1 AND phase!='settled')",
            [id.as_str()],
            |row| row.get(0),
        )?;
        if active {
            return Err(Error::Conflict("session has an unsettled run"));
        }
        let removed = tx.execute("DELETE FROM sessions WHERE id=?1", [id.as_str()])? > 0;
        tx.commit()?;
        Ok(removed)
    }
    pub fn prune_candidates(&self, before: u64, limit: usize) -> Result<Vec<Id>> {
        if !(1..=1000).contains(&limit) {
            return Err(xcb_core::Error::Invalid("prune limit").into());
        }
        let db = self.db()?;
        let mut query = db.prepare("SELECT id FROM sessions WHERE last_active<?1 AND NOT EXISTS(SELECT 1 FROM runs WHERE session=sessions.id AND phase!='settled') ORDER BY last_active,id LIMIT ?2")?;
        let rows = query.query_map(params![sql(before)?, limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| Ok(Id::new(row?)?)).collect()
    }
    pub fn set_models(&self, provider: Provider, choices: &[ModelChoice]) -> Result<()> {
        if choices.len() > 4096 {
            return Err(xcb_core::Error::Limit("models").into());
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM models WHERE provider=?1", [provider.as_str()])?;
        for choice in choices {
            choice.validate()?;
            if choice.provider != provider {
                return Err(Error::Conflict("model provider mismatch"));
            }
            tx.execute(
                "INSERT INTO models VALUES(?1,?2,?3)",
                params![
                    provider.as_str(),
                    choice.key(),
                    serde_json::to_string(choice)?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn models(&self) -> Result<Vec<ModelChoice>> {
        let db = self.db()?;
        let mut query = db.prepare("SELECT payload FROM models ORDER BY provider,id LIMIT 4097")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut choices = Vec::new();
        for row in rows {
            let choice: ModelChoice = decode(&row?)?;
            choice.validate()?;
            choices.push(choice);
        }
        if choices.len() > 4096 {
            return Err(xcb_core::Error::Limit("models").into());
        }
        Ok(choices)
    }
    pub fn record_usage(&self, observation: &UsageObservation) -> Result<()> {
        observation.counters.total()?;
        observation.model.validate()?;
        let session = self
            .session(&observation.session)?
            .ok_or(Error::Unavailable("session not found"))?;
        if session.account != observation.account
            || session.model.provider != observation.model.provider
        {
            return Err(Error::Conflict("usage binding mismatch"));
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT payload FROM usage WHERE id=?1",
                [observation.id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            let prior: UsageObservation = decode(&prior)?;
            if prior.session != observation.session
                || prior.account != observation.account
                || prior.model.key() != observation.model.key()
                || !observation.counters.dominates(prior.counters)
                || observation.at_ms < prior.at_ms
            {
                return Err(Error::Conflict("usage revision is inconsistent"));
            }
        }
        tx.execute("INSERT INTO usage VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload", params![observation.id.as_str(), observation.session.as_str(), observation.account.as_str(), sql(observation.at_ms)?, serde_json::to_string(observation)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn usage(&self, session: Option<&Id>, limit: usize) -> Result<Vec<UsageObservation>> {
        if !(1..=2048).contains(&limit) {
            return Err(xcb_core::Error::Invalid("usage page limit").into());
        }
        let db = self.db()?;
        let mut query = db.prepare("SELECT payload FROM usage WHERE (?1 IS NULL OR session=?1) ORDER BY observed_at DESC,id LIMIT ?2")?;
        let rows = query.query_map(params![session.map(Id::as_str), limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut observations = Vec::new();
        for row in rows {
            let observation: UsageObservation = decode(&row?)?;
            observation.counters.total()?;
            observations.push(observation);
        }
        observations.reverse();
        Ok(observations)
    }
    pub fn record_quota(&self, point: &QuotaPoint) -> Result<()> {
        point.validate()?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json = serde_json::to_string(point)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT payload FROM quotas WHERE pool=?1 AND window=?2 AND observed_at=?3",
                params![
                    point.pool.as_str(),
                    point.window.as_str(),
                    sql(point.observed_at_ms)?
                ],
                |row| row.get(0),
            )
            .optional()?;
        if prior.as_ref().is_some_and(|old| old != &json) {
            return Err(Error::Conflict("conflicting quota observation"));
        }
        tx.execute(
            "INSERT OR IGNORE INTO quotas VALUES(?1,?2,?3,?4)",
            params![
                point.pool.as_str(),
                point.window.as_str(),
                sql(point.observed_at_ms)?,
                json
            ],
        )?;
        tx.execute("DELETE FROM quotas WHERE pool=?1 AND window=?2 AND observed_at NOT IN (SELECT observed_at FROM quotas WHERE pool=?1 AND window=?2 ORDER BY observed_at DESC LIMIT 128)", params![point.pool.as_str(), point.window.as_str()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn select_pane(&self, id: &Id, pane: &Id) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut session = session_from(&tx, id)?.ok_or(Error::Unavailable("session not found"))?;
        let expected = session.revision;
        session.revision = expected
            .checked_add(1)
            .ok_or(Error::Conflict("revision overflow"))?;
        session.pane = pane.clone();
        update_session(&tx, &session, expected)?;
        tx.commit()?;
        Ok(())
    }
    pub fn rebind(&self, id: &Id, expected: u64, account: &Id, model: ModelChoice) -> Result<()> {
        let target = self.account(account)?;
        model.validate()?;
        if !target.enabled || target.provider != model.provider {
            return Err(Error::Conflict("target account mismatch"));
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut session = session_from(&tx, id)?.ok_or(Error::Unavailable("session not found"))?;
        let held: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE session=?1 AND phase!='settled')",
            [id.as_str()],
            |row| row.get(0),
        )?;
        if held || session.revision != expected {
            return Err(Error::Conflict("session is busy or changed"));
        }
        session.account = account.clone();
        session.model = model;
        session.revision = expected
            .checked_add(1)
            .ok_or(Error::Conflict("revision overflow"))?;
        session.state = State::Idle;
        update_session(&tx, &session, expected)?;
        tx.execute(
            "UPDATE sessions SET account=?1 WHERE id=?2",
            params![account.as_str(), id.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn begin_tool(
        &self,
        run: &RunRecord,
        call: &str,
        operation: &str,
        input_digest: &str,
    ) -> Result<()> {
        label(call, 160)?;
        let db = self.db()?;
        let held: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE account=?1 AND run=?2)",
            params![run.account.as_str(), run.id.as_str()],
            |row| row.get(0),
        )?;
        if !held {
            return Err(Error::Conflict("tool run no longer owns the account"));
        }
        db.execute(
            "INSERT INTO tool_effects(run,call,operation,input_digest) VALUES(?1,?2,?3,?4)",
            params![run.id.as_str(), call, operation, input_digest],
        )?;
        Ok(())
    }
    pub(crate) fn settle_tool(&self, run: &RunRecord, call: &str) -> Result<()> {
        if self.db()?.execute(
            "UPDATE tool_effects SET settled=1 WHERE run=?1 AND call=?2 AND settled=0",
            params![run.id.as_str(), call],
        )? != 1
        {
            return Err(Error::Conflict("tool receipt changed"));
        }
        Ok(())
    }
    pub fn record_velocity(
        &self,
        session: &Id,
        sample: xcb_core::usage::VelocitySample,
    ) -> Result<()> {
        if sample.output_tokens > xcb_core::usage::COUNTER_LIMIT {
            return Err(xcb_core::Error::Limit("velocity counter").into());
        }
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<(i64, i64)> = tx.query_row("SELECT at_ms,output_total FROM velocity WHERE session=?1 ORDER BY at_ms DESC LIMIT 1", [session.as_str()], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        if previous.is_some_and(|(at, count)| {
            at > sample.at_ms as i64 || count > sample.output_tokens as i64
        }) {
            return Err(Error::Conflict("velocity counter regressed"));
        }
        tx.execute("INSERT INTO velocity VALUES(?1,?2,?3) ON CONFLICT(session,at_ms) DO UPDATE SET output_total=excluded.output_total", params![session.as_str(), sql(sample.at_ms)?, sql(sample.output_tokens)?])?;
        tx.execute("DELETE FROM velocity WHERE session=?1 AND at_ms NOT IN (SELECT at_ms FROM velocity WHERE session=?1 ORDER BY at_ms DESC LIMIT 2048)", [session.as_str()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn velocities(
        &self,
        session: &Id,
        since: u64,
    ) -> Result<Vec<xcb_core::usage::VelocitySample>> {
        let db = self.db()?;
        let mut statement = db.prepare("SELECT at_ms,output_total FROM velocity WHERE session=?1 AND at_ms>=?2 ORDER BY at_ms LIMIT 2048")?;
        let rows = statement.query_map(params![session.as_str(), sql(since)?], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.map(|row| {
            let (at, count) = row?;
            Ok(xcb_core::usage::VelocitySample {
                at_ms: u64::try_from(at).map_err(|_| Error::Conflict("stored velocity time"))?,
                output_tokens: u64::try_from(count)
                    .map_err(|_| Error::Conflict("stored velocity counter"))?,
            })
        })
        .collect()
    }
    pub fn quotas(&self, pool: &Id) -> Result<Vec<QuotaPoint>> {
        let db = self.db()?;
        let mut query =
            db.prepare("SELECT payload FROM quotas WHERE pool=?1 ORDER BY observed_at LIMIT 2049")?;
        let rows = query.query_map([pool.as_str()], |row| row.get::<_, String>(0))?;
        let mut points = Vec::new();
        for row in rows {
            let point: QuotaPoint = decode(&row?)?;
            point.validate()?;
            points.push(point);
        }
        if points.len() > 2048 {
            return Err(xcb_core::Error::Limit("quota windows").into());
        }
        Ok(points)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use xcb_core::{
        Provider,
        models::{Mode, ModelChoice},
    };

    fn root() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("work")).unwrap();
        directory
    }

    fn choice() -> ModelChoice {
        ModelChoice {
            provider: Provider::Claude,
            id: Id::new("claude-fable-5-1").unwrap(),
            label: "Fable 5.1".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: Some(Id::new("max").unwrap()),
            observed_at_ms: 1,
        }
    }

    #[test]
    fn recovery_settles_running_run_and_marks_session_uncertain() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        let digest = digest(serde_json::to_string(&running).unwrap());

        let settled = store.recover_run(&running.id, &digest, 4).unwrap();

        assert_eq!(settled.phase, "settled");
        assert_eq!(settled.pid, Some(12345));
        assert!(store.run(&running.id).unwrap().unwrap().phase == "settled");
        assert!(store.unsettled_runs().unwrap().is_empty());
        let session = store.session(&session.id).unwrap().unwrap();
        assert_eq!(session.state, State::Uncertain);
        assert_eq!(session.revision, 2);
        assert!(store.recover_run(&running.id, &digest, 5).is_err());
        assert_eq!(store.session(&session.id).unwrap().unwrap().revision, 2);
    }

    #[test]
    fn recovery_digest_binds_the_stored_serialization() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        let payload = format!(" {} ", serde_json::to_string(&running).unwrap());
        store
            .db()
            .unwrap()
            .execute(
                "UPDATE runs SET payload=?1 WHERE id=?2",
                params![payload, running.id.as_str()],
            )
            .unwrap();
        let (candidate, payload_digest) = store.recovery_candidate(&running.id).unwrap().unwrap();

        assert_eq!(candidate.id, running.id);
        assert_eq!(payload_digest, digest(payload.as_bytes()));
        assert!(store.recover_run(&running.id, &payload_digest, 4).is_ok());
    }

    #[test]
    fn recovery_rejects_prepared_run_with_no_recorded_pid() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let digest = digest(serde_json::to_string(&prepared).unwrap());
        assert!(store.recover_run(&prepared.id, &digest, 4).is_err());
        assert_eq!(store.unsettled_runs().unwrap().len(), 1);
    }

    #[test]
    fn recovery_rejects_already_settled_run() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        store
            .settle(&prepared, State::Failed, 4)
            .expect("settle prepared run");
        let digest = digest(serde_json::to_string(&prepared).unwrap());
        assert!(store.recover_run(&prepared.id, &digest, 5).is_err());
        assert_eq!(store.unsettled_runs().unwrap().len(), 0);
    }

    #[test]
    fn recovery_rejects_run_that_changed_since_proof() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        assert!(store.recover_run(&running.id, "not-the-digest", 4).is_err());
        assert_eq!(store.run(&running.id).unwrap().unwrap().phase, "running");
    }

    #[test]
    fn recovery_rejects_run_when_lease_is_absent() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        let digest = digest(serde_json::to_string(&running).unwrap());
        store
            .db()
            .unwrap()
            .execute("DELETE FROM leases WHERE run=?1", [running.id.as_str()])
            .unwrap();
        assert!(store.recover_run(&running.id, &digest, 4).is_err());
        assert_eq!(store.run(&running.id).unwrap().unwrap().phase, "running");
    }

    #[test]
    fn run_record_roundtrip_persists_session_model() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let expected = session.model.clone();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        assert_eq!(prepared.model, Some(expected.clone()));
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        assert_eq!(running.model, Some(expected.clone()));
        store.settle(&running, State::Idle, 4).unwrap();
        let settled = store.run(&running.id).unwrap().unwrap();
        assert_eq!(settled.model.as_ref().unwrap().id, expected.id);
        assert_eq!(settled.model.as_ref().unwrap().provider, expected.provider);
        assert_eq!(settled.model.as_ref().unwrap().effort, expected.effort);
        assert!(store.unsettled_runs().unwrap().is_empty());
    }

    #[test]
    fn rebind_after_settlement_preserves_run_record_model() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let personal = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let work = store
            .add_account(Provider::Claude, "Work", "Team", 1)
            .unwrap();
        let original = choice();
        let session = store
            .create_session(&personal.id, original.clone(), &base.join("work"), 2)
            .unwrap();
        let run = store.prepare_run(&session.id, session.revision, 3).unwrap();
        store.settle(&run, State::Idle, 4).unwrap();
        let next_model = ModelChoice {
            provider: Provider::Claude,
            id: Id::new("claude-sonnet-4").unwrap(),
            label: "Sonnet 4".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: Some(Id::new("high").unwrap()),
            observed_at_ms: 5,
        };
        let current = store.session(&session.id).unwrap().unwrap();
        store
            .rebind(&session.id, current.revision, &work.id, next_model.clone())
            .unwrap();
        let settled = store.run(&run.id).unwrap().unwrap();
        assert_eq!(settled.account, personal.id);
        assert_eq!(settled.model, Some(original));
        let rebound = store.session(&session.id).unwrap().unwrap();
        assert_eq!(rebound.account, work.id);
        assert_eq!(rebound.model.id, next_model.id);
    }

    #[test]
    fn legacy_run_record_deserializes_without_model_field() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let run_id = Id::new("r_legacy001").unwrap();
        let payload = format!(
            "{{\"id\":\"{}\",\"session\":\"{}\",\"account\":\"{}\",\"revision\":1,\"phase\":\"running\",\"pid\":12345,\"created_at_ms\":1}}",
            run_id, session.id, account.id
        );
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO runs(id,session,account,phase,payload) VALUES(?1,?2,?3,'running',?4)",
                params![
                    run_id.as_str(),
                    session.id.as_str(),
                    account.id.as_str(),
                    payload
                ],
            )
            .unwrap();
        let run = store.run(&run_id).unwrap().unwrap();
        assert_eq!(run.model, None);
        assert_eq!(run.phase, "running");
        assert_eq!(run.pid, Some(12345));
    }

    #[test]
    fn probe_run_records_model_or_none() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let model = choice();
        let run = store
            .prepare_probe(&account.id, Some(model.clone()), 1)
            .unwrap();
        assert_eq!(run.model, Some(model.clone()));
        store.settle(&run, State::Idle, 2).unwrap();
        let stored = store.run(&run.id).unwrap().unwrap();
        assert_eq!(stored.model, Some(model));
        let unresolved = store.prepare_probe(&account.id, None, 3).unwrap();
        assert_eq!(unresolved.model, None);
        let devin = ModelChoice {
            provider: Provider::Devin,
            id: Id::new("x").unwrap(),
            label: "X".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: None,
            observed_at_ms: 1,
        };
        assert!(store.prepare_probe(&account.id, Some(devin), 4).is_err());
    }

    #[test]
    fn recovery_digest_matches_stored_payload_for_new_record() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let expected = session.model.clone();
        let prepared = store.prepare_run(&session.id, session.revision, 3).unwrap();
        let running = store.mark_spawned(&prepared, 12345).unwrap();
        let expected_digest = digest(serde_json::to_string(&running).unwrap());
        let (candidate, stored_digest) = store.recovery_candidate(&running.id).unwrap().unwrap();
        assert_eq!(candidate.model, Some(expected.clone()));
        assert_eq!(stored_digest, expected_digest);
        let settled = store.recover_run(&running.id, &stored_digest, 4).unwrap();
        assert_eq!(settled.model, Some(expected));
    }

    #[test]
    fn recovery_digest_matches_stored_payload_for_legacy_record() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let store = Store::open(&base.join("state")).unwrap();
        let account = store
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = store
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let run_id = Id::new("r_legacy002").unwrap();
        let payload = format!(
            "{{\"id\":\"{}\",\"session\":\"{}\",\"account\":\"{}\",\"revision\":1,\"phase\":\"running\",\"pid\":12345,\"created_at_ms\":1}}",
            run_id, session.id, account.id
        );
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO runs(id,session,account,phase,payload) VALUES(?1,?2,?3,'running',?4)",
                params![
                    run_id.as_str(),
                    session.id.as_str(),
                    account.id.as_str(),
                    &payload
                ],
            )
            .unwrap();
        store
            .db()
            .unwrap()
            .execute(
                "INSERT INTO leases(account,run) VALUES(?1,?2)",
                params![account.id.as_str(), run_id.as_str()],
            )
            .unwrap();
        let expected_digest = digest(payload.as_bytes());
        let (candidate, stored_digest) = store.recovery_candidate(&run_id).unwrap().unwrap();
        assert_eq!(candidate.model, None);
        assert_eq!(stored_digest, expected_digest);
        let settled = store.recover_run(&run_id, &stored_digest, 4).unwrap();
        assert_eq!(settled.model, None);
        assert_eq!(settled.phase, "settled");
        assert!(store.unsettled_runs().unwrap().is_empty());
    }

    #[test]
    fn run_owner_distinguishes_a_live_foreign_run_from_an_unsettled_one() {
        let dir = root();
        let base = dir.path().canonicalize().unwrap();
        let path = base.join("state");
        // Two handles on one state root stand in for two terminals.
        let owner = Store::open(&path).unwrap();
        let account = owner
            .add_account(Provider::Claude, "Personal", "Max", 1)
            .unwrap();
        let session = owner
            .create_session(&account.id, choice(), &base.join("work"), 2)
            .unwrap();
        let run = owner.prepare_run(&session.id, session.revision, 3).unwrap();
        let stamped = run.owner.as_ref().expect("new runs record their owner");
        assert_eq!(stamped.instance, owner.instance());
        assert_eq!(stamped.pid, std::process::id());
        assert!(stamped.alive());

        let viewer = Store::open(&path).unwrap();
        assert_ne!(viewer.instance(), owner.instance());
        // A live run owned elsewhere is remote work, not a recovery candidate.
        assert!(viewer.remote_active(&session.id).unwrap());
        // The owner itself never classifies its own run as remote.
        assert!(!owner.remote_active(&session.id).unwrap());

        // Once the owning process is gone the same row is genuinely unsettled.
        let dead = {
            let mut child = std::process::Command::new("true").spawn().unwrap();
            let pid = child.id();
            child.wait().unwrap();
            pid
        };
        let mut payload: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&run).unwrap()).unwrap();
        payload["owner"]["instance"] = serde_json::Value::String("i_foreign".into());
        payload["owner"]["pid"] = serde_json::Value::from(dead);
        owner
            .db()
            .unwrap()
            .execute(
                "UPDATE runs SET payload=?1 WHERE id=?2",
                params![payload.to_string(), run.id.as_str()],
            )
            .unwrap();
        assert!(!viewer.remote_active(&session.id).unwrap());

        // A legacy row written before owners existed is likewise unsettled.
        payload.as_object_mut().unwrap().remove("owner");
        owner
            .db()
            .unwrap()
            .execute(
                "UPDATE runs SET payload=?1 WHERE id=?2",
                params![payload.to_string(), run.id.as_str()],
            )
            .unwrap();
        assert!(!viewer.remote_active(&session.id).unwrap());
    }
}
