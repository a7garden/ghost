mod apple_container;
#[cfg(feature = "lifetime")]
pub mod local_browser;
mod registry;

pub use apple_container::{
    parse_cli_result, AppleCliOutcome, AppleContainerBackend, AppleContainerCliPlan,
    APPLE_CONTAINER_CLI_VERSION, APPLE_CONTAINER_OUTPUT_LIMIT, PINNED_TASK_IMAGE,
};
pub use registry::{
    BrowserAction, BrowserServiceBinding, ComputerLifecycle, ComputerRegistry, HomeManifest,
    LeaseKind, LeaseView, NativeWorkerBackendFacts, RuntimeFacts,
};
#[cfg(feature = "lifetime")]
pub use local_browser::{
    browser_service_binding, probe_is_configured, OwnedBrowser, OwnedBrowserComputer,
    OwnedBrowserConfig, OwnedBrowserLifecycle, OWNED_BROWSER_BACKEND_ID,
};
