# Changelog

## Unreleased

- Adopted the Garden framework for its components (`garden.json`, `vendor/garden` 0.1.0).
  Controls come from `@garden/ui` (shadcn/ui-style, Radix-backed); color and spacing use
  Tailwind 4 with Garden tokens. Removed `@garden/arc`, the Docket/liquid-glass
  stylesheets and the page-local control CSS. The layout stays Ghost's own sidebar and
  main region (recorded `shell.layout` exception).
- Sidebar: 홈 · Ghosts (the open Ghost expands into 대화 · 맡은 일 · package views ·
  이전 대화) · 프로젝트 · 설정. The title bar Ghost switcher is gone. Team, extensions and
  host live in settings; `/host`, `/providers` and `/integrations` redirect there.
- 홈 is a composer to the default Ghost plus pending decisions, ongoing work and projects.
- Host starter Ghosts show role names (주 Ghost, 리서치, 엔지니어링, 운영).
- The package manager is bun.
