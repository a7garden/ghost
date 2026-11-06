# Garden adoption setup

The Garden desktop infrastructure was initialized for framework version 0.1.0. This records CLI setup only. It does not claim that the existing application has been migrated to Garden APIs or conforms to the semantic and runtime requirements.

## Remaining work

- Compose the existing React application with @garden/ui and GAppShell; the CLI did not rewrite application source.
- Connect the existing document flow to @garden/editor and @garden/markdown while preserving its data and source files.
- Exercise pane collapse and reopen, command search and focus return, settings, themes, compact layouts, and changed document paths.
- Record actual build, test, and running-path evidence before claiming semantic or runtime conformance.
- garden doctor: src-tauri/Cargo.toml: stack.desktop requires a Rust Cargo manifest
- garden doctor: src-tauri/tauri.conf.json: stack.desktop configuration is missing
- garden doctor: src-tauri/tauri.conf.json: stack.desktop requires undecorated windows outside macOS
- garden doctor: src-tauri/tauri.macos.conf.json: stack.desktop configuration is missing
- garden doctor: src-tauri/tauri.macos.conf.json: stack.desktop requires the native macOS overlay and traffic-light position
