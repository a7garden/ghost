# Garden UI component snapshot

Ghost uses the public `GPanel` and `Card` APIs for its right conversation sidebar and task graph editor. Selected source files and their dependency closure are copied unchanged from the installed Garden framework 0.1.0. `ghost-adoption.json` records provenance and hashes. The package entry point is limited to these selected APIs.

Ghost supplies domain content, disclosure state, toggle state, and its existing narrow-screen dialog/focus handling. `src/sidebar.css` adapts the inset presentation to Ghost’s existing semantic tokens without importing a competing global theme or Tailwind reset. This is component reuse, not a full Garden app migration; no Garden lifecycle manifest is introduced.
