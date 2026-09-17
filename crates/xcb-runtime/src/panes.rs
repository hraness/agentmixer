use crate::{Error, Result, digest, private};
use std::{collections::BTreeMap, fs, path::Path};
use xcb_core::{Id, panes::{MAX_PANE_BYTES, Pane}};

pub fn list(root: &Path) -> Result<Vec<Pane>> {
    let mut panes: BTreeMap<Id, Pane> = Pane::presets().into_iter().map(|pane| (pane.id.clone(), pane)).collect();
    let directory = root.join("panes");
    private::check_directory(&directory)?;
    let mut count = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        count += 1;
        if count > 128 { return Err(xcb_core::Error::Limit("pane files").into()); }
        if entry.path().extension().is_none_or(|extension| extension != "json") { continue; }
        if entry.file_type()?.is_symlink() { continue; }
        if let Ok(pane) = private::read(&entry.path(), MAX_PANE_BYTES).and_then(|bytes| Pane::parse(&bytes).map_err(Into::into)) {
            if entry.file_name().to_str() == Some(&format!("{}.json", pane.id)) { panes.insert(pane.id.clone(), pane); }
        }
    }
    Ok(panes.into_values().collect())
}

pub fn load(root: &Path, id: &Id) -> Result<(Pane, Option<String>)> {
    let path = root.join("panes").join(format!("{id}.json"));
    match private::read(&path, MAX_PANE_BYTES) {
        Ok(bytes) => { let pane = Pane::parse(&bytes)?; if &pane.id != id { return Err(Error::Conflict("pane file identity mismatch")); } Ok((pane, Some(digest(bytes)))) }
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Pane::presets().into_iter().find(|pane| &pane.id == id).map(|pane| (pane, None)).ok_or(Error::Unavailable("pane not found"))
        }
        Err(error) => Err(error),
    }
}

pub fn save(root: &Path, pane: &Pane, revision: Option<&str>) -> Result<()> {
    pane.validate()?;
    let bytes = serde_json::to_vec_pretty(pane)?;
    let path = root.join("panes").join(format!("{}.json", pane.id));
    match revision { Some(revision) => private::replace(&path, &bytes, revision), None => private::create(&path, &bytes) }
}
