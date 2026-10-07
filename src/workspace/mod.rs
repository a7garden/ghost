//! Embedded web client for the Ghost control service. It owns no agent state.
use anyhow::Result;
use std::path::Path;
pub(crate) const INDEX: &str = include_str!("index.html");
pub(crate) const CSS: &str = include_str!("style.css");
pub(crate) const TOKENS: &str = include_str!("tokens.css");
pub(crate) const JS: &str = include_str!("app.js");
pub(crate) const WORKFLOWS: &str = include_str!("workflows.js");

/// Compatibility entry point for the optional web client.
pub fn serve(root: &Path, port: u16, model: Option<&str>) -> Result<()> {
    crate::control::server::serve(root, port, model, true)
}
