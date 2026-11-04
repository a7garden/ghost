# Ghost console design

The Ghost console uses **Ghost Glass**, a restrained interpretation of Apple's
Liquid Glass for a personal assistant workspace. The owner requested a modern,
minimal redesign across the console on 2026-10-11. This is a web implementation,
not a claim to reproduce a particular OS release or native optical refraction.

## Design decisions

- Genre: modern-minimal. App family: Workbench; conversation with independently
  collapsible navigation and context rails. Keep existing destinations and terms.
- A neutral porcelain or charcoal desktop supports an inset canvas and floating navigation.
  Glass is reserved for the sidebar, toolbar and overlays; the composer is an opaque input surface. Reading,
  planning and document surfaces are opaque. No decorative backgrounds.
- Display and body: the existing system sans stack (SF on Apple systems).
  Monospace is reserved for source and technical values. Roman headings only.
- Neutral surfaces avoid a blue cast; a desaturated blue accent identifies actions, focus and selection. Status
  colors retain their meanings; text labels accompany color indicators.
- The Ghost mark and avatars remain the product identity. No external assets or
  fonts are required.

## Source of truth

`tokens.css` at this repository root supplies the product palette, geometry,
material, spacing and typography roles. It is imported after the compatibility
base at `apps/ghost-ui/tokens.css`. Both the root and the nested Arc theme scope
receive the semantic overrides; the provider's data-theme must not restore the
old neutral palette. `apps/ghost-ui/src/liquid-glass.css` is the presentation layer,
loaded after the existing component styles. Vendor files are not edited.

Spacing uses a 4px base: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Page headings are
24–28px, body text 14px, controls 13px and supporting labels 12px. Cards have an
10px radius, shells 14px, controls and fields use an 8px radius, and the composer uses 12px.
Desktop action and navigation rows are 32px; icon buttons are 30px. Touch
controls retain a minimum 44px target. Desktop navigation is 224px wide with
8px canvas gutters. The
existing component radius tokens remain available for compatibility.

## Screen inventory and layout

| Screen / owner | Layout decision |
| --- | --- |
| `App.tsx`, `WorkspaceSidebar.tsx` | Floating navigation with a visible Ghost wordmark, search field, grouped destinations and distinct selected rows. Main canvas uses a shared toolbar. |
| `Overview.tsx` | Review requests span the content width. Ghost collection is primary; running work occupies a narrow activity column only while tasks are running. Otherwise Ghosts use two columns on larger screens. Search stays visible and can be cleared with its button or Escape. Stack on smaller screens. |
| `DotDetail.tsx`, routing conversation | A quiet edge-aligned toolbar and opaque composer surround a continuous reading area. Empty conversations center a compact avatar, name, role excerpt and short starters in the transcript area. The composer stays anchored at the bottom in both empty and populated threads. Selecting a suggestion focuses the input. Context uses compact opaque cards in a quieter rail, becoming an existing drawer below its breakpoint. |
| `WorkViews.tsx` — work | Goals, work and schedules retain their list structure; shared controls and compact row spacing establish hierarchy. |
| `WorkViews.tsx` — inbox | Review/task rows prioritize the requested decision; action groups wrap on small screens. |
| `Planner.tsx`, `ConnectedPlanner.tsx` | Date navigation becomes a compact control surface. Week selection is clear; local tasks and events occupy distinct columns where space permits. |
| `WorkViews.tsx` — spaces | Quieter document thumbnails and consistent cards; readers keep their existing sandbox and authored styling. |
| `CollaborationView.tsx`, `OrchestrationView.tsx` | Shared view tabs and material palette, with smaller avatars and tighter relationship cards. Preserve actual delegation and dependency graph layouts. |
| `Integrations.tsx` | Service rows with restrained icon tiles; setup guidance remains secondary. |
| `Settings.tsx`, `ModelSettings.tsx` | Stable category navigation beside one opaque content surface; categories wrap above content at narrower widths. |
| Voice and `LifetimeView.tsx` | Inherit shared color, controls and material roles; preserve voice states, graph/work hierarchy and feature gating. |
| `Modal.tsx` and pickers | Elevated glass, opaque inputs, visible focus, inherited native-dialog focus and dismissal behavior. |

## Accessibility and motion

- Keep visible focus rings immediate. Animate only existing transform/opacity
  interactions; do not add ambient movement or hover magnification.
- Respect reduced motion, increased contrast and reduced transparency.
- No backdrop-filter support: use the opaque glass fallback.
- Pointer-coarse controls have a 44px minimum target.
- Test at 320, 375, 414, 768 and desktop widths, in both themes. Do not mask content
  clipping merely by setting root overflow; inspect individual elements too.
- Existing loading, disabled, error and success states remain functional.

## Content boundaries

No document storage, parsing, links, source bytes or preview semantics change.
PDC 2 Markdown/HTML and PDC 1 read-only legacy behavior follow `docs/pdc-adoption.md`.
Presentation styles must not reach into sandboxed document content.

## Reference

[Apple Human Interface Guidelines — Materials](https://developer.apple.com/design/human-interface-guidelines/materials):
use material to distinguish navigation and controls while preserving legibility.

## Exports

The executable CSS export is [`tokens.css`](tokens.css); it includes light and dark
palettes and compatibility aliases. This application uses plain CSS, so no runtime
Tailwind or shadcn dependency is introduced. For consumers, map `paper` to
`background`, `ink` to `foreground`, `accent` to `primary`, `accent-ink` to
`primary-foreground`, `rule` to `border` and `focus` to `ring`. DTCG consumers can
export the same named color roles with `$type: color`; spacing roles have
`$type: dimension`. Keep those exports derived from the CSS source, not separately
maintained copies.
