//! Source-preserving document plane. New writes use PDC 2 Markdown or HTML;
//! PDC 1 and unmarked legacy sources remain readable and are never rewritten.
#[cfg(not(feature = "documents"))]
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub writable: bool,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub id: Option<String>,
    pub locator: String,
    pub title: String,
    pub hash: String,
    pub profile: String,
    /// PDC 1 documents and unmarked legacy files are always read-only.
    #[serde(default)]
    pub legacy: bool,
    pub diagnostic: Option<String>,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub links: Vec<DocumentLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentLink {
    pub id: String,
    pub label: String,
    pub fragment: Option<String>,
    pub state: String,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(feature = "documents")]
#[path = "documents_impl.rs"]
mod enabled;

#[cfg(feature = "documents")]
pub use enabled::{
    create, import_asset, initialize, list, new_source, proposed_source, read, read_source,
    timestamp, update,
};

#[cfg(not(feature = "documents"))]
fn unavailable<T>() -> Result<T> {
    Err(anyhow!(
        "document adapter unavailable; enable the `documents` feature"
    ))
}

#[cfg(not(feature = "documents"))]
pub fn timestamp() -> Result<String> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn list(_space: &Space, _query: &str) -> Result<Vec<Page>> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn read(_space: &Space, _id: &str) -> Result<Page> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn read_source(_space: &Space, _locator: &str) -> Result<Page> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn initialize(_space: &Space) -> Result<()> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn create(
    _space: &Space,
    _id: &str,
    _title: &str,
    _body: &str,
    _profile: &str,
    _created: &str,
) -> Result<Page> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn new_source(
    _id: &str,
    _title: &str,
    _body: &str,
    _profile: &str,
    _created: &str,
) -> Result<(String, Vec<u8>)> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn import_asset(_space: &Space, _source: &std::path::Path) -> Result<serde_json::Value> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn proposed_source(
    _current: &Page,
    _title: &str,
    _body: &str,
    _updated: &str,
) -> Result<Vec<u8>> {
    unavailable()
}
#[cfg(not(feature = "documents"))]
pub fn update(
    _space: &Space,
    _id: &str,
    _expected: &str,
    _title: &str,
    _body: &str,
    _updated: &str,
) -> Result<Page> {
    unavailable()
}
