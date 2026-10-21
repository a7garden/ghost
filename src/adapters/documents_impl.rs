//! Source-preserving document plane. New writes use PDC 2; legacy PDC 1
//! documents remain readable and are never rewritten in place.
use super::{digest, DocumentLink, Page, Space};
use anyhow::{anyhow, bail, Result};
use oxi_frontmatter::pdc::{self, BodyProfile, Classification, DocumentExt};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub fn timestamp() -> Result<String> {
    let now = time::OffsetDateTime::now_utc();
    Ok(format!(
        "{}.{:03}Z",
        now.format(&time::format_description::parse_borrowed::<2>(
            "[year]-[month]-[day]T[hour]:[minute]:[second]"
        )?)?,
        now.millisecond()
    ))
}
fn ext(path: &Path) -> Result<DocumentExt> {
    match path.extension().and_then(|s| s.to_str()) {
        Some("html") => Ok(DocumentExt::Html),
        Some("djot") => Ok(DocumentExt::Djot),
        Some("md") => Ok(DocumentExt::Markdown),
        _ => bail!("unsupported document extension"),
    }
}
fn bounded(path: &Path) -> Result<Vec<u8>> {
    if path.symlink_metadata()?.file_type().is_symlink() {
        bail!("document symlink is not followed");
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take((pdc::MAX_DOCUMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > pdc::MAX_DOCUMENT_BYTES {
        bail!("document_too_large");
    }
    Ok(bytes)
}
fn canonical_body(body: &str) -> Result<String> {
    if body.starts_with('\u{feff}') || body.contains('\r') {
        bail!("canonical PDC 2 bodies must use UTF-8 without a BOM and LF line endings");
    }
    if body.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("{}\n", body.trim_end_matches('\n')))
}
fn safe_path(space: &Space, locator: &str) -> Result<PathBuf> {
    if space.path.is_symlink() {
        bail!("Space root must not be a symlink");
    }
    let root = space.path.canonicalize()?;
    let path = Path::new(locator);
    if path
        .components()
        .any(|c| !matches!(c,Component::Normal(s) if !s.to_string_lossy().starts_with('.')))
    {
        bail!("invalid document locator");
    }
    let mut result = root.clone();
    for part in path.components() {
        result.push(part);
        if result
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            bail!("document symlink is not followed");
        }
    }
    if !result.starts_with(root) {
        bail!("document outside Space");
    }
    Ok(result)
}
fn projection(space: &Space, locator: &str, include_source: bool) -> Result<Page> {
    let path = safe_path(space, locator)?;
    let bytes = bounded(&path)?;
    let source = String::from_utf8(bytes.clone()).map_err(|_| anyhow!("document is not UTF-8"))?;
    let mut page = Page {
        id: None,
        locator: locator.into(),
        title: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        hash: digest(&bytes),
        profile: "unclassified".into(),
        legacy: false,
        diagnostic: None,
        deleted: false,
        source: include_source.then(|| source.clone()),
        body: None,
        preview: None,
        diagnostics: vec![],
        links: vec![],
    };
    match pdc::classify(ext(&path)?, &bytes) {
        Classification::Valid(doc) => {
            page.id = Some(doc.id);
            page.profile = doc.profile.id_str().into();
            page.legacy = doc.legacy;
            if let Some(title) = doc.envelope.get("title").and_then(|v| v.as_str()) {
                if !title.is_empty() {
                    page.title = title.into();
                }
            }
            page.deleted = doc
                .envelope
                .get("deleted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if include_source {
                let body = source[doc.body_range].to_string();
                if !doc.legacy {
                    let (html, links, diagnostics) = render_in(space, doc.profile, &body)?;
                    page.preview = Some(html);
                    page.links = links;
                    page.diagnostics = diagnostics;
                }
                page.body = Some(body);
            }
        }
        Classification::LegacyHtml => {
            page.legacy = true;
            page.diagnostic = Some("legacy_html: readable without conversion".into())
        }
        Classification::LegacyMarkdown => {
            page.legacy = true;
            page.diagnostic = Some("legacy_markdown: readable without conversion".into())
        }
        Classification::Invalid(e) => page.diagnostic = Some(e.to_string()),
    }
    Ok(page)
}
fn scan(root: &Path, relative: &Path, items: &mut Vec<String>) -> Result<()> {
    if relative.components().count() > 64 {
        bail!("Space directory nesting exceeds its limit");
    }
    if items.len() >= 10_000 {
        bail!("Space listing exceeds its document limit; choose a narrower root");
    }
    for item in fs::read_dir(root.join(relative))? {
        let item = item?;
        let name = item.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = item.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let rel = relative.join(name);
        if kind.is_dir() {
            scan(root, &rel, items)?;
        } else if kind.is_file() && ext(&rel).is_ok() {
            items.push(rel.to_string_lossy().into());
        }
    }
    Ok(())
}
pub fn list(space: &Space, query: &str) -> Result<Vec<Page>> {
    if space.path.is_symlink() {
        bail!("Space root must not be a symlink");
    }
    let mut paths = Vec::new();
    scan(&space.path, Path::new(""), &mut paths)?;
    paths.sort();
    let mut pages = Vec::new();
    let mut ids = BTreeMap::<String, usize>::new();
    for path in paths {
        let p = projection(space, &path, false).unwrap_or_else(|e| Page {
            id: None,
            locator: path.clone(),
            title: path,
            hash: String::new(),
            profile: "diagnostic".into(),
            legacy: false,
            diagnostic: Some(e.to_string()),
            deleted: false,
            source: None,
            body: None,
            preview: None,
            diagnostics: vec![],
            links: vec![],
        });
        if let Some(id) = &p.id {
            *ids.entry(id.clone()).or_default() += 1;
        }
        pages.push(p);
    }
    for p in &mut pages {
        if p.id.as_ref().is_some_and(|id| ids[id] > 1) {
            p.diagnostic = Some("duplicate_document_id".into());
        }
    }
    let query = query.to_lowercase();
    pages.retain(|p| {
        query.is_empty()
            || p.title.to_lowercase().contains(&query)
            || p.locator.to_lowercase().contains(&query)
            || safe_path(space, &p.locator)
                .and_then(|path| bounded(&path))
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .is_some_and(|source| source.to_lowercase().contains(&query))
    });
    Ok(pages)
}
pub fn read(space: &Space, id: &str) -> Result<Page> {
    let pages = list(space, "")?;
    let matches: Vec<_> = pages
        .iter()
        .filter(|p| p.id.as_deref() == Some(id))
        .collect();
    if matches.len() != 1 {
        bail!("document missing or duplicate_document_id");
    }
    projection(space, &matches[0].locator, true)
}
pub fn read_source(space: &Space, locator: &str) -> Result<Page> {
    projection(space, locator, true)
}
pub fn initialize(space: &Space) -> Result<()> {
    if !space.writable {
        bail!("Space is read-only");
    }
    if space.path.is_symlink() {
        bail!("Space root must not be a symlink");
    }
    fs::create_dir_all(&space.path)?;
    let meta = space.path.join(".pdc");
    if meta.is_symlink() {
        bail!("vault manifest directory must not be a symlink");
    }
    fs::create_dir_all(&meta)?;
    let path = meta.join("vault.json");
    if path.exists() {
        let value: serde_json::Value = serde_json::from_slice(&bounded(&path)?)?;
        let id = value["id"].as_str().unwrap_or("");
        let canonical_id = uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.get_version_num() == 7 && uuid.to_string() == id);
        let created = value["created"].as_str().unwrap_or("");
        let canonical_time = created.len() == 24
            && created.ends_with('Z')
            && created.as_bytes().get(19) == Some(&b'.')
            && time::OffsetDateTime::parse(created, &time::format_description::well_known::Rfc3339)
                .is_ok();
        if value["format"] != "pdc-vault/1" || !canonical_id || !canonical_time {
            bail!("invalid vault manifest");
        }
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(
        &serde_json::json!({"format":"pdc-vault/1","id":uuid::Uuid::now_v7().to_string(),"created":timestamp()?}),
    )?;
    create_exact(&path, &bytes)
}
fn create_exact(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        let existing = if bytes.len() > pdc::MAX_DOCUMENT_BYTES {
            asset_bytes(path)?
        } else {
            bounded(path)?
        };
        if existing == bytes {
            return Ok(());
        }
        bail!("existing target has different content; inspect before retry");
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("document directory missing"))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist_noclobber(path)
        .map_err(|e| anyhow!("document create failed: {}", e.error))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn new_source(
    id: &str,
    title: &str,
    body: &str,
    profile: &str,
    created: &str,
) -> Result<(String, Vec<u8>)> {
    let uuid = uuid::Uuid::parse_str(id)?;
    if uuid.get_version_num() != 7 || uuid.to_string() != id {
        bail!("new document identity must be a canonical UUIDv7");
    }
    if title.len() > 640 || title.contains(['\n', '\r', '\0']) {
        bail!("invalid document title");
    }
    let (extension, body_profile, opening, closing) = match profile {
        "pdc-markdown/1" => ("md", "pdc-markdown/1", "---\n", "---\n"),
        "pdc-html/1" => ("html", "pdc-html/1", "<!--\n---\n", "---\n-->\n"),
        _ => bail!("new documents must use a PDC 2 Markdown or HTML profile"),
    };
    let body = canonical_body(body)?;
    let bytes = format!("{opening}format: pdc-document/2\nbody: {body_profile}\nid: {id}\ncreated: {created}\nupdated: {created}\ntitle: {}\n{closing}{body}",serde_json::to_string(title)?).into_bytes();
    if !matches!(
        pdc::classify(ext(Path::new(&format!("a.{extension}")))?, &bytes),
        Classification::Valid(doc) if !doc.legacy && doc.profile.id_str() == body_profile
    ) {
        bail!("invalid or unsafe new PDC document");
    }
    Ok((format!("{id}.{extension}"), bytes))
}
pub fn create(
    space: &Space,
    id: &str,
    title: &str,
    body: &str,
    profile: &str,
    created: &str,
) -> Result<Page> {
    let (locator, bytes) = new_source(id, title, body, profile, created)?;
    initialize(space)?;
    create_exact(&safe_path(space, &locator)?, &bytes)?;
    projection(space, &locator, true)
}
pub fn proposed_source(current: &Page, title: &str, body: &str, updated: &str) -> Result<Vec<u8>> {
    let source = current
        .source
        .as_deref()
        .ok_or_else(|| anyhow!("source unavailable"))?;
    let extension = ext(Path::new(&current.locator))?;
    let Classification::Valid(doc) = pdc::classify(extension, source.as_bytes()) else {
        bail!("unsupported_lossless_edit");
    };
    if doc.legacy || current.legacy {
        bail!("legacy_document_read_only: create a separate PDC 2 target after backup");
    }
    if current.title == title && current.body.as_deref() == Some(body) {
        return Ok(source.as_bytes().to_vec());
    }
    let body = if current.body.as_deref() == Some(body) {
        // Metadata-only edits preserve authored body bytes, including legacy
        // line endings in a valid PDC 2 source.
        body.to_owned()
    } else {
        canonical_body(body)?
    };
    let mut next = source.as_bytes()[..doc.body_range.start].to_vec();
    next.extend_from_slice(body.as_bytes());
    let next = pdc::patch_metadata(extension, &next, &[("title", title), ("updated", updated)])
        .map_err(|e| anyhow!(e.to_string()))?;
    let Classification::Valid(result) = pdc::classify(extension, &next) else {
        bail!("invalid or unsafe PDC edit");
    };
    if result.id != doc.id || result.profile != doc.profile {
        bail!("document identity or profile changed");
    }
    Ok(next)
}
pub fn update(
    space: &Space,
    id: &str,
    expected: &str,
    title: &str,
    body: &str,
    updated: &str,
) -> Result<Page> {
    if !space.writable {
        bail!("Space is read-only");
    }
    let current = read(space, id)?;
    if current.hash != expected {
        bail!("external_change_conflict: source changed; re-read before editing");
    }
    let source = current
        .source
        .as_deref()
        .ok_or_else(|| anyhow!("source unavailable"))?;
    let extension = ext(Path::new(&current.locator))?;
    let Classification::Valid(doc) = pdc::classify(extension, source.as_bytes()) else {
        bail!("unsupported_lossless_edit");
    };
    if doc.legacy || current.legacy {
        bail!("legacy_document_read_only: create a separate PDC 2 target after backup");
    }
    if current.body.as_deref() == Some(body) && current.title == title {
        return Ok(current);
    }
    let next = proposed_source(&current, title, body, updated)?;
    let Classification::Valid(next_doc) = pdc::classify(extension, &next) else {
        bail!("invalid or unsafe PDC edit");
    };
    if next_doc.id != id || next_doc.profile != doc.profile {
        bail!("document identity or profile changed");
    }
    initialize(space)?;
    let path = safe_path(space, &current.locator)?;
    let lock_path = space.path.join(".pdc/ghost-writer.lock");
    if lock_path.is_symlink() {
        bail!("vault lock must not be a symlink");
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)?;
    fs2::FileExt::try_lock_exclusive(&lock)?;
    pdc::save_guarded(source.as_bytes(), &bounded(&path)?, next.clone())
        .map_err(|e| anyhow!(e.to_string()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(&space.path)?;
    tmp.write_all(&next)?;
    tmp.as_file().sync_all()?;
    // Recheck immediately before replacement. Foreign writers must follow the
    // same compare-before-replace contract; hostile concurrent mutation remains
    // an OS filesystem boundary, not a claim of a process sandbox.
    pdc::save_guarded(source.as_bytes(), &bounded(&path)?, next.clone())
        .map_err(|e| anyhow!(e.to_string()))?;
    tmp.persist(&path)
        .map_err(|e| anyhow!("document replacement failed: {}", e.error))?;
    File::open(path.parent().ok_or_else(|| anyhow!("parent missing"))?)?.sync_all()?;
    projection(space, &current.locator, true)
}
fn body_html(profile: BodyProfile, body: &str) -> String {
    match profile {
        BodyProfile::Html => body.to_owned(),
        BodyProfile::Djot => jotdown::html::render_to_string(jotdown::Parser::new(body)),
        BodyProfile::Markdown => {
            let mut output = String::new();
            pulldown_cmark::html::push_html(
                &mut output,
                pulldown_cmark::Parser::new_ext(body, pulldown_cmark::Options::all()),
            );
            output
        }
    }
}
fn asset_path(space: &Space, hash: &str) -> Result<PathBuf> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid_asset_digest");
    }
    if space.path.is_symlink() {
        bail!("Space root must not be a symlink");
    }
    let mut path = space.path.canonicalize()?;
    for component in [".pdc", "assets", "sha256", &hash[..2], hash] {
        path.push(component);
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            bail!("asset symlink is not followed");
        }
    }
    Ok(path)
}
fn asset_bytes(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| anyhow!("missing_asset"))?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 {
        bail!("asset_too_large");
    }
    Ok(bytes)
}
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
pub fn import_asset(space: &Space, source: &Path) -> Result<serde_json::Value> {
    initialize(space)?;
    if !source.is_absolute() || source.is_symlink() {
        bail!("choose an absolute asset file without a symlink");
    }
    let bytes = asset_bytes(source)?;
    let hash = digest(&bytes);
    let path = asset_path(space, &hash)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("asset directory missing"))?;
    fs::create_dir_all(parent)?;
    create_exact(&path, &bytes)?;
    Ok(
        serde_json::json!({"uri":format!("pdc://asset/sha256/{hash}"),"digest":hash,"bytes":bytes.len(),"media_type":image_type(&bytes)}),
    )
}
fn block_exists(space: &Space, locator: &str, fragment: &str) -> bool {
    let Ok(path) = safe_path(space, locator) else {
        return false;
    };
    let Ok(bytes) = bounded(&path) else {
        return false;
    };
    let Ok(extension) = ext(&path) else {
        return false;
    };
    let Classification::Valid(doc) = pdc::classify(extension, &bytes) else {
        return false;
    };
    let Ok(body) = std::str::from_utf8(&bytes[doc.body_range]) else {
        return false;
    };
    let found = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = found.clone();
    let fragment = fragment.to_string();
    ammonia::Builder::default()
        .add_generic_attributes(["id"])
        .attribute_filter(move |_, attribute, value| {
            if attribute == "id" && value == fragment {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Some(value.into())
        })
        .clean(&body_html(doc.profile, body));
    found.load(std::sync::atomic::Ordering::SeqCst)
}
fn render_in(
    space: &Space,
    profile: BodyProfile,
    body: &str,
) -> Result<(String, Vec<DocumentLink>, Vec<String>)> {
    use base64::Engine;
    let pages = list(space, "")?;
    let space = space.clone();
    let observations = std::sync::Arc::new(std::sync::Mutex::new((
        Vec::<DocumentLink>::new(),
        Vec::<String>::new(),
    )));
    let captured = observations.clone();
    let safe=ammonia::Builder::default().add_tags(["style"]).rm_clean_content_tags(["style"]).add_generic_attributes(["style","id"]).add_url_schemes(["pdc","data"]).attribute_filter(move|element,attribute,value|{
        if element=="img"&&attribute=="src"{
            let result:Result<String>=(||{let hash=value.strip_prefix("pdc://asset/sha256/").ok_or_else(||anyhow!("external_or_noncanonical_image: source preserved; remote image loading disabled"))?;let bytes=asset_bytes(&asset_path(&space,hash)?)?;if digest(&bytes)!=hash{bail!("asset_digest_mismatch");}
if bytes.len()>8*1024*1024{bail!("asset exceeds preview limit; original remains available");}let mime=image_type(&bytes).ok_or_else(||anyhow!("asset media type has source fallback"))?;Ok(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)))})();
            return match result{Ok(data)=>Some(data.into()),Err(e)=>{if let Ok(mut obs)=captured.lock(){obs.1.push(e.to_string());}None}};
        }
        if element=="a"&&attribute=="href"{if let Some(target)=value.strip_prefix("pdc://document/"){
            let(id,fragment)=target.split_once('#').map(|(id,fragment)|(id,Some(fragment))).unwrap_or((target,None));
            let matches=pages.iter().filter(|p|p.id.as_deref()==Some(id)).collect::<Vec<_>>();let resolved=matches.len()==1&&matches[0].diagnostic.is_none()&&fragment.is_none_or(|f|f.starts_with("b-")&&block_exists(&space,&matches[0].locator,f));
            if let Ok(mut obs)=captured.lock(){obs.0.push(DocumentLink{id:id.into(),label:matches.first().map(|p|p.title.clone()).unwrap_or_else(||id.into()),fragment:fragment.map(String::from),state:if resolved{"resolved"}else{"broken_link"}.into()});if !resolved{obs.1.push(format!("broken_link: {value}"));}}return None;
        }}
        Some(value.into())
    }).clean(&body_html(profile,body)).to_string();
    let (links, diagnostics) = observations
        .lock()
        .map_err(|_| anyhow!("preview observations unavailable"))?
        .clone();
    Ok((format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'\"><style>body{{font:14px/1.65 system-ui;padding:20px;color:#222}}pre{{white-space:pre-wrap}}a{{pointer-events:none}}img{{max-width:100%;height:auto}}</style>{safe}"),links,diagnostics))
}

#[cfg(test)]
#[path = "documents_conformance_tests.rs"]
mod conformance_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_listing_preserves_good_sources_and_edit_cas_with_malformed_sibling() {
        let root = tempfile::tempdir().unwrap();
        let space_path = root.path().join("space");
        fs::create_dir_all(&space_path).unwrap();
        let space = Space {
            id: "fixture-space".into(),
            name: "Fixture".into(),
            path: space_path.clone(),
            writable: true,
            profiles: Vec::new(),
        };
        let id = uuid::Uuid::now_v7().to_string();
        let asset_ref =
            format!("pdc://asset/sha256/{}", "a".repeat(64));
        let body = format!("## Source body\n\n![Receipt]({asset_ref})");
        let expected_body = canonical_body(&body).unwrap();
        let (locator, initial) = new_source(
            &id,
            "Source preserving",
            &body,
            "pdc-markdown/1",
            "2026-10-09T01:00:00.000Z",
        )
        .unwrap();
        let initial = String::from_utf8(initial).unwrap();
        let source = initial.replacen(
            "title: \"Source preserving\"\n",
            "title: \"Source preserving\"\ncustom_metadata: keep-this-value\n",
            1,
        );
        assert_ne!(source, initial);
        fs::write(space.path.join(&locator), source.as_bytes()).unwrap();
        fs::write(space.path.join("malformed.md"), [0xff, 0xfe, 0xfd]).unwrap();
        let legacy = "# Read-only legacy source\n";
        fs::write(space.path.join("legacy.md"), legacy).unwrap();

        let pages = list(&space, "").unwrap();
        let good = pages
            .iter()
            .find(|page| page.id.as_deref() == Some(id.as_str()))
            .expect("valid source remains listed");
        assert!(good.diagnostic.is_none());
        assert!(
            pages
                .iter()
                .any(|page| page.locator == "malformed.md" && page.diagnostic.is_some())
        );
        let legacy_page = read_source(&space, "legacy.md").unwrap();
        assert!(legacy_page.legacy);
        assert_eq!(legacy_page.source.as_deref(), Some(legacy));

        let page = read_source(&space, &locator).unwrap();
        assert_eq!(page.source.as_deref(), Some(source.as_str()));
        assert_eq!(page.body.as_deref(), Some(expected_body.as_str()));
        assert!(page.source.as_deref().unwrap().contains(&asset_ref));
        assert!(
            update(
                &space,
                &id,
                "stale-hash",
                "Changed title",
                &body,
                "2026-10-09T01:01:00.000Z",
            )
            .is_err(),
            "stale source hashes must not overwrite the canonical document"
        );
        assert_eq!(
            fs::read(space.path.join(&locator)).unwrap().as_slice(),
            source.as_bytes()
        );

        let updated = update(
            &space,
            &id,
            &page.hash,
            "Changed title",
            &body,
            "2026-10-09T01:01:00.000Z",
        )
        .unwrap();
        assert_eq!(updated.id.as_deref(), Some(id.as_str()));
        let updated_source = fs::read_to_string(space.path.join(&locator)).unwrap();
        assert!(updated_source.contains("custom_metadata: keep-this-value"));
        assert!(updated_source.contains(&asset_ref));
        assert!(updated_source.ends_with(&expected_body));
        assert_eq!(
            fs::read(space.path.join("malformed.md")).unwrap().as_slice(),
            &[0xff, 0xfe, 0xfd]
        );
        assert_eq!(fs::read_to_string(space.path.join("legacy.md")).unwrap(), legacy);
    }
}
