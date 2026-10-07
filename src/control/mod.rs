//! Authenticated local control transport shared by the host, browser UI, and CLI.

pub mod api;
mod client;
mod metadata;
pub(crate) mod server;

pub use client::ControlClient;
pub use server::serve;
