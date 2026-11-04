//! Capability adapters behind the Ghost host boundary.

pub mod channels;
pub mod computer;
pub mod documents;
pub mod memory;
pub mod memory_bindings;
#[cfg(feature = "caldav")]
pub mod personal_connectors;
