use xcb_runtime::{attachments, store::Store};

#[test]
fn clipboard_images_are_content_addressed_bounded_and_integrity_checked() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap().join("state");
    let store = Store::open(&root).unwrap();
    let image = attachments::from_rgba(store.root(), 2, 2, vec![255; 16]).unwrap();
    assert_eq!(image.media_type, "image/png");
    assert_eq!((image.width, image.height), (2, 2));
    let bytes = attachments::read(store.root(), &image).unwrap();
    assert_eq!(
        attachments::store(store.root(), &bytes).unwrap().digest,
        image.digest
    );
    assert!(attachments::from_rgba(store.root(), usize::MAX, 2, vec![]).is_err());
    assert!(attachments::store(store.root(), b"not an image").is_err());
}
