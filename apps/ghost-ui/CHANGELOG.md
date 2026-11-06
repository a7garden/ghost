# Changelog

## Unreleased

- Adopted the Garden framework (`garden.json`, `vendor/garden` 0.1.0). Controls come from
  `@garden/ui` (shadcn/ui-style, Radix-backed); layout and color use Tailwind 4 with
  Garden tokens. Removed `@garden/arc`, the Docket/liquid-glass stylesheets and the
  page-local control CSS.
- The console is a `GAppShell` with an activity rail for 대화 · 일 · 프로젝트 · 설정; the
  sidebar lists only the selected workspace's destinations. The open Ghost expands into
  대화 · 맡은 일 · package views · 이전 대화. The title bar Ghost switcher is gone.
- 새 요청 is a composer to the default Ghost plus pending decisions. Team, extensions and
  host live in settings; `/host`, `/providers` and `/integrations` redirect there.
- Host starter Ghosts show role names (주 Ghost, 리서치, 엔지니어링, 운영).
- The package manager is bun.
