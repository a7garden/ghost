# @garden/arc

Optional Arc free UI adapters for Garden. The pinned upstream registry contains 105 components and 22 blocks, plus a shared foundation. Every free ID has a public package subpath and a gallery specimen. See `manifest.json` for the complete ID list, license, source hashes, existing Garden correspondence, adaptations and measured verification status.

```tsx
import { ArcProvider } from '@garden/arc';
import { Button as ArcButton } from '@garden/arc/button';
import '@garden/arc/styles.css';

<ArcProvider theme={appearance} density="compact" motion="user">
  <ArcButton onClick={save}>{labels.save}</ArcButton>
</ArcProvider>
```

The root exports provider APIs only. It does not import the catalog or replace Garden Button. `@garden/arc/catalog` offers `ArcButton`, `ArcDialog`, etc. as namespaces for deliberate bulk imports. Use item subpaths in applications to keep unused module CSS and code out of bundles. This is a source package for Garden's Vite/Tauri toolchain, not an emitted CommonJS package or a published npm release.

Applications own their layout, domain operations, localized copy and theme state. The provider writes no global theme, permissions, storage or native state. Its independent `--g-arc-*` tokens preserve Arc geometry and colors by default; `tokens="garden"` opts into host semantic colors and Inter. Density and motion are independent. The provider is a transparent token boundary; the host paints its intended surface (for example `style={{background: "var(--g-arc-background)"}}`) when light and dark boundaries share a page. Supply a licensed Geist font using the foundation font variables if exact Arc typography is needed. Fonts are not fetched remotely by this package.

All overlays belong to the provider's local portal root. Mount the provider near the app root; transformed or clipped ancestors can affect fixed-position overlays. Custom Drawer container support remains available. Keep icons at their original 14–20px control scale. Radix supplies trap/restore behavior; neutral focus outlines restore upstream suppressed focus styling. Text controls preserve Garden's no-ring editing convention.

React/ReactDOM 19.3.0, Motion 13.4.0 and the Radix versions are pinned in package.json. Arc's lucide-react 1.47.0 is a separate dependency from Garden UI's existing version. Browser builds resolve each package normally; the server gallery bundles lucide so its exports cannot accidentally resolve to the gallery's older icon version. Node SSR consumers must bundle this source package and CSS modules rather than externalize it.

All 127 gallery specimens were server-rendered without window/document access during render. This does not certify hydration parity or server operation of browser gestures. Effects and event handlers use modern WebView APIs (ResizeObserver, PointerEvent, clipboard, canvas, file/object URLs). Clipboard, file access, downloads and microphone-style application permissions remain host responsibilities. No package callback gains native privileges.

Arc RichTextEditor is an HTML-fragment UI reference. It is not Garden's durable editor, PDC reader/writer or storage migration. Sign-in, signup, payment/plan, newsletter, upload and demo chat blocks have illustrative content or local simulation; applications must provide their domain callbacks. No authentication, billing, delivery, upload service or model integration is included.

Some vendor controls and blocks retain English default copy. `manifest.json` marks these production adaptation gaps instead of treating the developer gallery as a finished app. DialogContent and DrawerContent accept `closeLabel`; BottomSheet already accepts it. Block-level copy, specialized signature/color labels and simulated workflows require locale and domain review before production adoption. Automated axe results are scoped to the tested specimens and portals; manual assistive-technology and exhaustive gesture checks remain separate.

To adopt this optional reference catalog, create/update the installed Garden snapshot using the reviewed framework source, then select the optional module:

```sh
garden new my-app --template web --source /absolute/path/to/garden-ui --no-install
garden add arc /absolute/path/to/my-app
garden deps /absolute/path/to/my-app
garden doctor /absolute/path/to/my-app
```

`garden add` uses the app's installed snapshot and has no `--source` option. Existing apps first use `garden update <app> --source <garden-ui>` after reviewing migration/managed-file checks. Ghost and Cassette snapshots require separate app-owned adoption.

Preview: from the candidate root, `bun run --filter @garden/arc-gallery dev`, then open port 4318. Each item is addressable as `/?item=button`; scene, theme, locale, motion, tokens and density are selectable. Production gallery assets are in `apps/arc-gallery/dist`. Their full-catalog bundle is intentionally large; app imports should use item subpaths.

The original free MIT files are preserved under vendor/, with Elia Kuratli's LICENSE and NOTICE. `dependency-licenses.json` records the resolved dependency closure and copied license text. Demo photographs referenced by upstream but absent from the public repository are withheld; examples use our own inline illustration. Pro metadata is inventoried solely to document exclusion. No Pro source, paid install endpoint or code extracted from a site bundle is included.

Reference v2 repairs and reproducibility: `node scripts/rebuild-arc-adapters.mjs`
checks the canonical upstream-to-Garden patch against all 272 source hashes.
`--write` is permitted only when every current adapter already matches the
reviewed manifest; unreviewed edits cause a refusal before any write. Never rerun
the historical regex generator. See `docs/decisions/0011-arc-blocker-repairs.md`.

SignIn/ LoginCentered `onSignIn` and ChangelogFeed `onSubscribe` accept synchronous
or asynchronous callbacks. Rejected promises display an error and preserve a
retryable form. No callback supplies an authentication or delivery service.
Unavailable demo avatar/photo/logo artwork is represented by original local SVG
illustrations and letter marks; hosts supply licensed production assets.

Reference async limitation: LoginCentered and ChangelogFeed do not cancel or
invalidate a slow pending callback when the person changes the email path or
closes the subscription form with Escape. A late resolution can show completion
for the earlier attempt. Before connecting either reference to a real service,
add a host-owned generation guard and cancellation/AbortSignal handling; invalidate
on Change, Escape, unmount and a superseding submit. Do not use a late callback to
change the current auth/subscription state or to imply delivery for another input.
