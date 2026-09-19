use crate::{Result, config::Config, store::Store};
use std::collections::{BTreeMap, BTreeSet};
use xcb_core::{
    Id,
    models::sort_choices,
    ui::{AccountRow, View},
    usage::{Estimate, QuotaPoint, VelocitySample, runway, throughput_share, velocity},
};

pub fn snapshot(store: &Store, current: Option<&Id>, config: &Config, now: u64) -> Result<View> {
    let mut view = View {
        sessions: store.sessions(64)?,
        reduced_motion: config.reduced_motion,
        ..View::default()
    };
    let busy: BTreeSet<_> = store
        .unsettled_runs()?
        .into_iter()
        .map(|run| run.account)
        .collect();
    let mut independent_pools = BTreeMap::new();
    for account in store.accounts()? {
        let mut by_window: BTreeMap<Id, Vec<QuotaPoint>> = BTreeMap::new();
        for point in store.quotas(&account.quota_pool)? {
            by_window
                .entry(point.window.clone())
                .or_default()
                .push(point);
        }
        let fresh: Vec<_> = by_window
            .values()
            .filter_map(|points| points.last())
            .filter(|point| point.fresh(now))
            .collect();
        let remaining_percent = fresh
            .iter()
            .map(|point| 100.0 - point.used_percent)
            .reduce(f64::min);
        let resets_at_ms = fresh.iter().map(|point| point.resets_at_ms).min();
        let estimates: Vec<_> = by_window
            .values()
            .map(|points| runway(points, now))
            .collect();
        let estimate = if !estimates.is_empty()
            && estimates
                .iter()
                .all(|estimate| estimate.seconds().is_some())
        {
            Estimate::Known {
                seconds: estimates
                    .iter()
                    .filter_map(Estimate::seconds)
                    .reduce(f64::min)
                    .expect("nonempty estimates"),
            }
        } else {
            Estimate::unknown("quota_or_burn_unmeasured")
        };
        if account.enabled {
            independent_pools
                .entry(account.quota_pool.clone())
                .or_insert_with(|| estimate.clone());
        }
        view.accounts.push(AccountRow {
            id: account.id.clone(),
            provider: account.provider,
            label: account.label,
            subscription: account.subscription,
            remaining_percent,
            resets_at_ms,
            runway: estimate,
            busy: busy.contains(&account.id),
            enabled: account.enabled,
        });
    }
    let known: Vec<_> = independent_pools
        .values()
        .filter_map(Estimate::seconds)
        .collect();
    view.runway_coverage = (known.len(), independent_pools.len());
    view.total_runway_seconds = (!known.is_empty()).then(|| known.iter().sum());
    view.models = store.models()?;
    sort_choices(&mut view.models, &config.favorites);
    if let Some(id) = current {
        view.session = store.session(id)?;
        view.messages = store.messages(id, 128)?;
        if let Some(session) = &view.session {
            view.state = session.state;
        }
    }
    let mut by_session: BTreeMap<Id, Vec<VelocitySample>> = BTreeMap::new();
    let mut totals: BTreeMap<Id, u64> = BTreeMap::new();
    for usage in store.usage(None, 2048)? {
        let total = totals.entry(usage.session.clone()).or_default();
        *total = total.saturating_add(usage.counters.output);
        let samples = by_session.entry(usage.session).or_default();
        if let Some(last) = samples.last_mut().filter(|last| last.at_ms == usage.at_ms) {
            last.output_tokens = *total;
        } else {
            samples.push(VelocitySample {
                at_ms: usage.at_ms,
                output_tokens: *total,
            });
        }
    }
    let mut total_velocity = 0.0;
    let mut measured = false;
    for (id, samples) in by_session {
        let rate = velocity(&samples, now, 60_000);
        if let Some(rate) = rate {
            total_velocity += rate;
            measured = true;
        }
        if current == Some(&id) {
            view.tokens_per_second = rate;
        }
    }
    view.share_percent =
        throughput_share(view.tokens_per_second, measured.then_some(total_velocity)).0;
    view.extensions = vec![
        (
            "auto-continue".into(),
            if config.extensions.auto_continue.enabled {
                "on · bounded"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "gobstopper".into(),
            if config.extensions.gobstopper.enabled {
                "on · settled boundaries"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "judge".into(),
            if config.extensions.judge.enabled {
                "on · advisory"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "usage".into(),
            if config.extensions.usage {
                "local"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "hooks".into(),
            if config.extensions.hooks {
                "on · explicit trust"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "aiCharts export".into(),
            if config.extensions.aicharts_export && config.extensions.usage {
                "on · local idle"
            } else if config.extensions.aicharts_export {
                "blocked · usage off"
            } else {
                "off"
            }
            .into(),
        ),
        (
            "aiCharts upload".into(),
            if config.extensions.aicharts_upload {
                "waiting for supported enrolled ingress"
            } else {
                "off"
            }
            .into(),
        ),
    ];
    let selected = view
        .session
        .as_ref()
        .map(|session| &session.pane)
        .unwrap_or(&config.pane);
    match crate::panes::load(store.root(), selected) {
        Ok((pane, revision)) => {
            view.pane = pane;
            view.pane_revision = revision;
        }
        Err(error) => view.pane_error = Some(error.to_string()),
    }
    view.panes = crate::panes::list(store.root())?;
    Ok(view)
}
