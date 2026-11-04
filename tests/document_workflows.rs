#![cfg(feature = "documents")]
use ghost::adapters::documents::{self, Space};
use std::fs;
fn space(root: &std::path::Path) -> Space {
    Space {
        id: uuid::Uuid::now_v7().to_string(),
        name: "Notes".into(),
        path: root.into(),
        writable: true,
        profiles: vec![],
    }
}
#[test]
fn canonical_writes_preserve_noop_unknown_metadata_and_detect_external_edits() {
    let dir = tempfile::tempdir().unwrap();
    let s = space(dir.path());
    let id = uuid::Uuid::now_v7().to_string();
    let page = documents::create(
        &s,
        &id,
        "Owner note",
        "# Hello\n\nneedle in body\n",
        "pdc-markdown/1",
        "2026-10-03T00:00:00.000Z",
    )
    .unwrap();
    let path = s.path.join(&page.locator);
    let mut original = fs::read_to_string(&path).unwrap();
    original = original.replacen("title:", "tags: [personal]\n\ntitle:", 1);
    fs::write(&path, &original).unwrap();
    let current = documents::read(&s, &id).unwrap();
    documents::update(
        &s,
        &id,
        &current.hash,
        &current.title,
        current.body.as_deref().unwrap(),
        "2026-10-03T01:00:00.000Z",
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original,
        "noop changed source bytes"
    );
    assert_eq!(
        documents::list(&s, "needle").unwrap().len(),
        1,
        "body search missing"
    );
    let changed = documents::update(
        &s,
        &id,
        &current.hash,
        "Retitled",
        "New body\n",
        "2026-10-03T02:00:00.000Z",
    )
    .unwrap();
    assert!(changed
        .source
        .as_ref()
        .unwrap()
        .contains("tags: [personal]\n\n"));
    assert_eq!(changed.id.as_deref(), Some(id.as_str()));
    let external = fs::read_to_string(&path).unwrap() + "external edit\n";
    fs::write(&path, &external).unwrap();
    assert!(documents::update(
        &s,
        &id,
        &changed.hash,
        "Retitled",
        "replace",
        "2026-10-03T03:00:00.000Z"
    )
    .unwrap_err()
    .to_string()
    .contains("conflict"));
    assert_eq!(fs::read_to_string(path).unwrap(), external);
}
#[test]
fn html_preview_keeps_authored_styles_and_suppresses_active_content() {
    let dir = tempfile::tempdir().unwrap();
    let s = space(dir.path());
    let id = uuid::Uuid::now_v7().to_string();
    let body="<style>.owner{color:red}</style><p class=owner style=\"font-weight:bold\">Hello</p><img src=\"https://evil.invalid/a.png\">";
    let page = documents::create(
        &s,
        &id,
        "Layout",
        body,
        "pdc-html/1",
        "2026-10-03T00:00:00.000Z",
    )
    .unwrap();
    // Canonical PDC 2 bodies end with exactly one LF; the projection returns
    // the exact stored source slice.
    assert_eq!(page.body.as_deref(), Some(&format!("{body}\n")[..]));
    let html = page.preview.unwrap();
    assert!(html.contains("color:red") && html.contains("font-weight:bold"));
    assert!(!html.contains("onclick") && !html.contains("steal()") && !html.contains("<iframe"));
    assert!(!html.contains("src=\"https://evil.invalid"));
    assert!(!page.diagnostics.is_empty());
    let active="<p onclick=\"alert(1)\">Hello</p><script>steal()</script><iframe src=\"https://evil.invalid\"></iframe>";
    assert!(documents::create(
        &s,
        &uuid::Uuid::now_v7().to_string(),
        "Unsafe",
        active,
        "pdc-html/1",
        "2026-10-03T00:00:00.000Z"
    )
    .is_err());
    fs::write(s.path.join("legacy.html"), active).unwrap();
    let legacy = documents::read_source(&s, "legacy.html").unwrap();
    assert_eq!(legacy.source.as_deref(), Some(active));
    assert!(legacy.preview.is_none() && legacy.diagnostic.is_some());
}
#[test]
fn assets_and_identity_links_verify_content_and_surface_broken_references() {
    let dir = tempfile::tempdir().unwrap();
    let s = space(dir.path());
    let temp = tempfile::tempdir().unwrap();
    let image = temp.path().join("sample.png");
    fs::write(&image, b"\x89PNG\r\n\x1a\nfixture-pixels").unwrap();
    let asset = documents::import_asset(&s, &image).unwrap();
    let target = uuid::Uuid::now_v7().to_string();
    let block = format!("b-{}", uuid::Uuid::now_v7());
    documents::create(
        &s,
        &target,
        "Target",
        &format!("<p id=\"{block}\">Target</p>"),
        "pdc-html/1",
        "2026-10-03T00:00:00.000Z",
    )
    .unwrap();
    let missing = uuid::Uuid::now_v7().to_string();
    let id = uuid::Uuid::now_v7().to_string();
    let page=documents::create(&s,&id,"Links",&format!("<img src=\"{}\"><a href=\"pdc://document/{target}#{block}\">Target</a><a href=\"pdc://document/{missing}\">Missing</a>",asset["uri"].as_str().unwrap()),"pdc-html/1","2026-10-03T00:00:00.000Z").unwrap();
    assert!(page.preview.unwrap().contains("data:image/png;base64,"));
    assert!(page
        .links
        .iter()
        .any(|l| l.id == target && l.state == "resolved"));
    assert!(page
        .links
        .iter()
        .any(|l| l.id == missing && l.state == "broken_link"));
    let hash = asset["digest"].as_str().unwrap();
    fs::write(
        s.path
            .join(".pdc/assets/sha256")
            .join(&hash[..2])
            .join(hash),
        b"tampered",
    )
    .unwrap();
    assert!(documents::read(&s, &id)
        .unwrap()
        .diagnostics
        .iter()
        .any(|d| d.contains("asset_digest_mismatch")));
}
#[test]
fn duplicate_ids_symlinks_and_bad_manifests_are_visible_and_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let s = space(dir.path());
    let id = uuid::Uuid::now_v7().to_string();
    let page = documents::create(
        &s,
        &id,
        "Original",
        "body",
        "pdc-markdown/1",
        "2026-10-03T00:00:00.000Z",
    )
    .unwrap();
    fs::copy(s.path.join(&page.locator), s.path.join("duplicate.md")).unwrap();
    assert!(documents::read(&s, &id)
        .unwrap_err()
        .to_string()
        .contains("duplicate"));
    assert!(documents::list(&s, "")
        .unwrap()
        .iter()
        .all(|p| p.diagnostic.as_deref() == Some("duplicate_document_id")));
    assert!(documents::read_source(&s, "../escape.djot").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(s.path.join(&page.locator), s.path.join("alias.djot")).unwrap();
        assert!(documents::read_source(&s, "alias.djot").is_err());
    }
    fs::write(
        s.path.join(".pdc/vault.json"),
        "{\"format\":\"pdc-vault/1\",\"id\":\"wrong\"}",
    )
    .unwrap();
    assert!(documents::initialize(&s).is_err());
}
