use std::{fs, os::unix::fs::symlink};
use xcb_runtime::broker::Workspace;

#[test]
fn workspace_tools_are_descriptor_rooted_and_revision_checked() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fs::write(root.join("hello.txt"), "old").unwrap();
    let workspace = Workspace::open(&root).unwrap();
    let read = workspace.read("hello.txt").unwrap();
    assert_eq!(read.text, "old");
    workspace.write("hello.txt", "new", Some(&read.revision)).unwrap();
    assert!(workspace.write("hello.txt", "clobber", Some(&read.revision)).is_err());
    assert!(workspace.write("hello.txt", "clobber", None).is_err());
    workspace.write("new.txt", "created", None).unwrap();
    assert_eq!(fs::read_to_string(root.join("hello.txt")).unwrap(), "new");
}

#[test]
fn workspace_symlinks_hardlinks_and_parent_paths_do_not_escape() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    fs::create_dir(base.join("work")).unwrap();
    fs::write(base.join("private.txt"), "private").unwrap();
    symlink(base.join("private.txt"), base.join("work/link")).unwrap();
    fs::hard_link(base.join("private.txt"), base.join("work/hard")).unwrap();
    let workspace = Workspace::open(&base.join("work")).unwrap();
    for path in ["../private.txt", "/private.txt", "link", "hard"] { assert!(workspace.read(path).is_err(), "{path}"); }
    assert!(workspace.write("../private.txt", "bad", None).is_err());
    assert_eq!(fs::read_to_string(base.join("private.txt")).unwrap(), "private");
}

#[test]
fn native_mcp_tool_calls_refuse_unknown_keys_and_tools() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().canonicalize().unwrap()).unwrap();
    assert!(workspace.call("shell", &serde_json::json!({"command":"true"})).is_err());
    assert!(workspace.call("workspace_read", &serde_json::json!({"path":"a","extra":true})).is_err());
}
