//! Ghost document plane conformance against the pinned shared corpus
//! (`pdc-document-conformance/2`, revision 2). The corpus lives in the
//! canonical `portable-document-contract` repository; a revision drift must
//! fail loudly here instead of silently changing document behavior.
use super::{digest, read_source, update, Space};
use oxi_frontmatter::pdc::{self, Classification, DocumentExt};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn corpus_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("GHOST_PDC_CONFORMANCE_DIR") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../portable-document-contract/conformance")
}

fn corpus() -> BTreeMap<String, serde_json::Value> {
    let path = corpus_dir().join("corpus.json");
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(&path).unwrap_or_else(|error| panic!("pinned conformance corpus is missing at {}: {error}", path.display())),
    )
    .expect("conformance corpus.json must be valid JSON");
    assert_eq!(
        value["format"], "pdc-document-conformance/2",
        "shared conformance corpus format drifted"
    );
    assert_eq!(
        value["revision"], 2,
        "shared conformance corpus revision drifted; update Ghost expectations with the normative change"
    );
    let cases = value["cases"].as_array().expect("corpus cases array").clone();
    cases
        .into_iter()
        .map(|case| {
            let id = case["id"].as_str().expect("case id").to_string();
            (id, case)
        })
        .collect()
}

fn document_ext(name: &str) -> Option<DocumentExt> {
    match name.rsplit('.').next()? {
        "md" => Some(DocumentExt::Markdown),
        "html" => Some(DocumentExt::Html),
        "djot" => Some(DocumentExt::Djot),
        _ => None,
    }
}

fn space_with(name: &str, bytes: &[u8]) -> (tempfile::TempDir, Space) {
    let root = tempfile::tempdir().unwrap();
    let space_path = root.path().join("space");
    fs::create_dir_all(&space_path).unwrap();
    fs::write(space_path.join(name), bytes).unwrap();
    let space = Space {
        id: "conformance".into(),
        name: "Conformance".into(),
        path: space_path,
        writable: true,
        profiles: Vec::new(),
    };
    (root, space)
}

fn read_fixture(path: &str) -> Vec<u8> {
    fs::read(corpus_dir().join(path)).unwrap_or_else(|error| panic!("corpus fixture {path} is missing: {error}"))
}

fn diagnostic_prefix(space: &Space, locator: &str) -> String {
    // Oversized and otherwise unreadable sources appear as diagnostic pages
    // in the listing; direct reads propagate the error instead.
    super::list(space, "")
        .unwrap()
        .into_iter()
        .find(|page| page.locator == locator)
        .and_then(|page| page.diagnostic)
        .unwrap_or_default()
}

fn assert_expectation(space: &Space, locator: &str, expect: &str, original: &[u8]) {
    let page = read_source(space, locator).unwrap();
    match expect {
        "valid" => {
            let id = page.id.clone().expect("valid corpus documents expose their identity");
            assert!(!page.legacy, "{locator}: canonical documents are not legacy");
            assert!(page.diagnostic.is_none(), "{locator}: {:?}", page.diagnostic);
            assert!(
                page.profile == "pdc-markdown/1" || page.profile == "pdc-html/1",
                "{locator}: unexpected profile {}",
                page.profile
            );
            assert_eq!(
                page.source.as_deref().unwrap().as_bytes(),
                original,
                "{locator}: the shared corpus must survive Ghost's reader byte-for-byte"
            );
            let classified = pdc::classify(document_ext(locator).unwrap(), original);
            let Classification::Valid(doc) = classified else {
                panic!("{locator}: expected a valid classification");
            };
            assert_eq!(
                page.body.as_deref().unwrap(),
                &source_text(original)[doc.body_range.clone()],
                "{locator}: body projection must be the exact source slice"
            );
            let _ = id;
        }
        "legacy_valid" => {
            assert!(page.id.is_some(), "{locator}: legacy v1 documents keep their identity");
            assert!(page.legacy, "{locator}: {expect}");
            assert!(page.diagnostic.is_none(), "{locator}: {:?}", page.diagnostic);
            assert_eq!(page.source.as_deref().unwrap().as_bytes(), original);
            let id = page.id.clone().unwrap();
            let error = update(
                space,
                &id,
                &page.hash,
                &page.title,
                page.body.as_deref().unwrap_or_default(),
                "2026-10-11T00:00:00.000Z",
            )
            .err()
            .expect("legacy documents refuse writes");
            assert!(
                error.to_string().contains("legacy_document_read_only"),
                "{locator}: {error}"
            );
        }
        "legacy_html" | "legacy_markdown" => {
            assert!(page.legacy, "{locator}: {expect}");
            let diagnostic = page.diagnostic.as_deref().unwrap_or_default();
            assert!(
                diagnostic.starts_with(expect),
                "{locator}: diagnostic {diagnostic:?} must name {expect}"
            );
            assert_eq!(page.source.as_deref().unwrap().as_bytes(), original);
        }
        "valid_unexecuted" => {
            // `.base` queries are outside Ghost's claimed reader surface.
            panic!("{locator}: pdc-query/1 expectations are not mapped for Ghost documents");
        }
        diagnostic => {
            let actual = page.diagnostic.as_deref().unwrap_or_default();
            assert!(
                actual.starts_with(diagnostic),
                "{locator}: diagnostic {actual:?} must name {diagnostic}"
            );
        }
    }
}

fn source_text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("corpus fixtures are UTF-8")
}

fn deep_yaml_envelope() -> String {
    let mut deep = String::from("---\na:\n");
    for indent in 1..33 {
        deep.push_str(&" ".repeat(2 * indent));
        deep.push_str("b:\n");
    }
    deep.push_str("---\n");
    deep
}

fn nested_quotes_body() -> String {
    // 257 simultaneously open block-quote containers exceed the 256 limit.
    format!("{}x\n", "> ".repeat(257))
}

#[test]
fn shared_revision2_reader_cases_classify_as_the_corpus_requires() {
    let cases = corpus();
    for (id, case) in &cases {
        if case["kind"] != "file" {
            continue;
        }
        let path = case["path"].as_str().expect("file case path");
        if path.ends_with(".base") {
            // Ghost's document plane lists Markdown, HTML and Djot documents;
            // pdc-query/1 `.base` files are not a claimed Ghost surface, and
            // fenced `base` blocks are preserved as source by the reader.
            continue;
        }
        let original = read_fixture(path);
        let name = Path::new(path).file_name().unwrap().to_string_lossy().into_owned();
        let (_root, space) = space_with(&name, &original);
        assert_expectation(&space, &name, case["expect"].as_str().unwrap(), &original);
        let _ = id;
    }
}

#[test]
fn shared_revision2_set_cases_flag_duplicate_document_ids() {
    let cases = corpus();
    for (id, case) in &cases {
        if case["kind"] != "set" {
            continue;
        }
        let root = tempfile::tempdir().unwrap();
        let space_path = root.path().join("space");
        fs::create_dir_all(&space_path).unwrap();
        let mut names = Vec::new();
        for path in case["paths"].as_array().expect("set paths") {
            let path = path.as_str().unwrap();
            let name = Path::new(path).file_name().unwrap().to_string_lossy().into_owned();
            fs::write(space_path.join(&name), read_fixture(path)).unwrap();
            names.push(name);
        }
        let space = Space {
            id: "conformance".into(),
            name: "Conformance".into(),
            path: space_path,
            writable: true,
            profiles: Vec::new(),
        };
        let pages = super::list(&space, "").unwrap();
        let duplicated: Vec<&str> = pages
            .iter()
            .filter(|page| page.diagnostic.as_deref() == Some("duplicate_document_id"))
            .map(|page| page.locator.as_str())
            .collect();
        assert_eq!(
            duplicated.len(),
            names.len(),
            "{id}: every set member must stay visible with duplicate_document_id; got {duplicated:?}"
        );
        assert_eq!(case["expect"], "duplicate_document_id");
    }
}

#[test]
fn shared_revision2_operation_cases_preserve_and_conflict_exactly() {
    let cases = corpus();
    for (id, case) in &cases {
        if case["kind"] != "operation" {
            continue;
        }
        let operation = case["operation"].as_str().unwrap();
        let input_path = case["input"].as_str().unwrap();
        let name = Path::new(input_path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let original = read_fixture(input_path);
        match operation {
            "prefix-source-bytes" => {
                let prefix = case["prefixHex"].as_str().unwrap();
                let prefix = (0..prefix.len())
                    .step_by(2)
                    .map(|index| u8::from_str_radix(&prefix[index..index + 2], 16).unwrap())
                    .collect::<Vec<u8>>();
                let mut bytes = prefix;
                bytes.extend_from_slice(&original);
                let (_root, space) = space_with(&name, &bytes);
                assert!(
                    diagnostic_prefix(&space, &name)
                        .starts_with(case["expect"].as_str().unwrap()),
                    "{id}: {:?}",
                    diagnostic_prefix(&space, &name)
                );
            }
            "pad-body-to-total-bytes" => {
                let total = case["totalBytes"].as_u64().unwrap() as usize;
                let mut bytes = original.clone();
                assert!(total > bytes.len(), "{id}: padding must grow the input");
                bytes.resize(total, b' ');
                let (_root, space) = space_with(&name, &bytes);
                assert!(
                    diagnostic_prefix(&space, &name)
                        .starts_with(case["expect"].as_str().unwrap()),
                    "{id}: {:?}",
                    diagnostic_prefix(&space, &name)
                );
            }
            "replace-envelope-with-yaml-mapping-depth" => {
                let depth = case["depth"].as_u64().unwrap();
                assert_eq!(depth, 33, "{id}: the corpus case pins the depth");
                let classified = pdc::classify(document_ext(&name).unwrap(), &original);
                let Classification::Valid(doc) = classified else {
                    panic!("{id}: operation input must classify");
                };
                let mut bytes = deep_yaml_envelope().into_bytes();
                bytes.extend_from_slice(&original[doc.body_range]);
                let (_root, space) = space_with(&name, &bytes);
                assert!(
                    diagnostic_prefix(&space, &name)
                        .starts_with(case["expect"].as_str().unwrap()),
                    "{id}: {:?}",
                    diagnostic_prefix(&space, &name)
                );
            }
            "replace-body-with-nested-block-quotes" => {
                let depth = case["containerDepth"].as_u64().unwrap();
                assert_eq!(depth, 257, "{id}: the corpus case pins the depth");
                let classified = pdc::classify(document_ext(&name).unwrap(), &original);
                let Classification::Valid(doc) = classified else {
                    panic!("{id}: operation input must classify");
                };
                let mut bytes = original[..doc.body_range.start].to_vec();
                bytes.extend_from_slice(nested_quotes_body().as_bytes());
                let (_root, space) = space_with(&name, &bytes);
                assert!(
                    diagnostic_prefix(&space, &name)
                        .starts_with(case["expect"].as_str().unwrap()),
                    "{id}: {:?}",
                    diagnostic_prefix(&space, &name)
                );
            }
            "no-op-round-trip" => {
                let (_root, space) = space_with(&name, &original);
                let page = read_source(&space, &name).unwrap();
                let source = page.source.clone().unwrap();
                let classified = pdc::classify(document_ext(&name).unwrap(), source.as_bytes());
                let Classification::Valid(doc) = classified else {
                    panic!("{id}: operation input must classify");
                };
                if doc.legacy {
                    // Ghost's mutator role covers canonical PDC 2 only; PDC 1
                    // sources stay read-only, so the shared legacy mutator
                    // bytes are intentionally not claimed by this adapter.
                    let error = super::proposed_source(
                        &page,
                        &page.title,
                        page.body.as_deref().unwrap(),
                        doc.envelope
                            .get("updated")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default(),
                    )
                    .err()
                    .expect("{id}: legacy sources refuse rewrites");
                    assert!(
                        error.to_string().contains("legacy_document_read_only"),
                        "{id}: {error}"
                    );
                    continue;
                }
                let updated = doc
                    .envelope
                    .get("updated")
                    .and_then(|value| value.as_str())
                    .expect("corpus operation inputs carry an updated timestamp")
                    .to_string();
                let proposed = super::proposed_source(&page, &page.title, page.body.as_deref().unwrap(), &updated)
                    .unwrap_or_else(|error| panic!("{id}: {error}"));
                assert_eq!(
                    proposed.as_slice(),
                    original.as_slice(),
                    "{id}: a no-op write must return the exact source bytes"
                );
            }
            "metadata-patch" => {
                let (_root, space) = space_with(&name, &original);
                let page = read_source(&space, &name).unwrap();
                let title = case["patch"]["title"].as_str().unwrap();
                let updated = case["patch"]["updated"].as_str().unwrap();
                let legacy = matches!(
                    pdc::classify(document_ext(&name).unwrap(), &original),
                    Classification::Valid(doc) if doc.legacy
                );
                if legacy {
                    let error = super::proposed_source(&page, title, page.body.as_deref().unwrap(), updated)
                        .err()
                        .expect("{id}: legacy sources refuse rewrites");
                    assert!(
                        error.to_string().contains("legacy_document_read_only"),
                        "{id}: {error}"
                    );
                    continue;
                }
                let proposed = super::proposed_source(&page, title, page.body.as_deref().unwrap(), updated)
                    .unwrap_or_else(|error| panic!("{id}: {error}"));
                let expected = read_fixture(case["expected"].as_str().unwrap());
                assert_eq!(
                    proposed.as_slice(),
                    expected.as_slice(),
                    "{id}: the metadata patch must be byte-identical to the shared expectation"
                );
            }
            "external-change-before-save" => {
                let (_root, space) = space_with(&name, &original);
                let page = read_source(&space, &name).unwrap();
                let id = page.id.clone().unwrap();
                let external = read_fixture(case["external"].as_str().unwrap());
                fs::write(space.path.join(&name), &external).unwrap();
                let error = update(
                    &space,
                    &id,
                    &page.hash,
                    &page.title,
                    page.body.as_deref().unwrap_or_default(),
                    "2026-10-11T00:00:00.000Z",
                )
                .err()
                .unwrap_or_else(|| panic!("{id}: external change must conflict"));
                assert!(
                    error.to_string().contains("external_change_conflict"),
                    "{id}: {error}"
                );
                assert_eq!(
                    fs::read(space.path.join(&name)).unwrap(),
                    external,
                    "{id}: a conflicting save must never overwrite the external source"
                );
            }
            other => panic!("{id}: unknown conformance operation {other}; extend Ghost's suite with the normative change"),
        }
    }
}

#[test]
fn ghost_writer_output_satisfies_the_shared_reader_for_both_profiles() {
    // New Ghost writes must be canonical PDC 2 in both body profiles.
    let id = uuid::Uuid::now_v7().to_string();
    for profile in ["pdc-markdown/1", "pdc-html/1"] {
        let body = "## Preserved\n\n- 항목\n";
        let (locator, bytes) =
            super::new_source(&id, "Corpus writer", body, profile, "2026-10-11T00:00:00.000Z").unwrap();
        let classified = pdc::classify(document_ext(&locator).unwrap(), &bytes);
        let Classification::Valid(doc) = classified else {
            panic!("{profile}: Ghost writer output must classify");
        };
        assert!(!doc.legacy && doc.profile.id_str() == profile);
    }
}
