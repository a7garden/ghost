//! Capability adapters behind the Ghost host boundary.

pub mod channels;
pub mod computer;
pub mod documents;
pub mod memory;
#[cfg(feature = "caldav")]
pub mod personal_connectors;
