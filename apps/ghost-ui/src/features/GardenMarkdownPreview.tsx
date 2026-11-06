type Theme = 'light' | 'dark';

/** Garden's scale, restated for the isolated preview document. */
const gardenMarkdownScale = `
  :root {
    --g-space-1: 4px;
    --g-space-2: 8px;
    --g-space-3: 12px;
    --g-space-4: 16px;
    --g-space-5: 20px;
    --g-space-6: 24px;
    --g-space-8: 32px;
    --radius-chip: 6px;
    --radius-control: 8px;
    --text-ui: 13px;
    --text-caption: 12px;
    --text-body: 14px;
    --text-body--line-height: 1.5;
    --text-bodyLg: 16px;
    --text-bodyLg--line-height: 1.56;
    --text-heading: 20px;
    --text-heading--line-height: 1.35;
    --text-headingSm: 18px;
    --text-headingSm--line-height: 1.4;
    --text-headingLg: 24px;
    --text-headingLg--line-height: 1.3;
    --g-layout-document-max: 760px;
    --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
`;

const gardenMarkdownPalettes: Record<Theme, string> = {
  light: `
    :root {
      color-scheme: light;
      --g-ink: #1a1c1f;
      --g-ink2: color-mix(in srgb, var(--g-ink) 65%, transparent);
      --g-canvas: #ffffff;
      --g-inset: #f9f9f9;
      --g-line: color-mix(in srgb, var(--g-ink) 8%, transparent);
      --g-line-strong: color-mix(in srgb, var(--g-ink) 12%, transparent);
      --g-accent-ink: #0169cc;
      --g-accent-tint: #e5f3ff;
    }
  `,
  dark: `
    :root {
      color-scheme: dark;
      --g-ink: #dfdfdf;
      --g-ink2: color-mix(in srgb, var(--g-ink) 65%, transparent);
      --g-canvas: #181818;
      --g-inset: #131313;
      --g-line: color-mix(in srgb, var(--g-ink) 8%, transparent);
      --g-line-strong: color-mix(in srgb, var(--g-ink) 12%, transparent);
      --g-accent-ink: #66b5ff;
      --g-accent-tint: color-mix(in srgb, #339cff 16%, transparent);
    }
  `,
};

const presentation = `
  html { background: var(--g-canvas); }
  body {
    box-sizing: border-box;
    width: min(100%, calc(var(--g-layout-document-max) + 2 * var(--g-space-8)));
    margin: 0 auto;
    padding: var(--g-space-8);
    background: var(--g-canvas);
    color: var(--g-ink);
    font: var(--text-body)/var(--text-body--line-height) var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  h1, h2, h3, h4, h5, h6 { color: var(--g-ink); font-weight: 600; letter-spacing: -.02em; }
  h1 { margin: 0 0 var(--g-space-6); font-size: var(--text-headingLg); line-height: var(--text-headingLg--line-height); letter-spacing: -.025em; }
  h2 { margin: var(--g-space-6) 0 var(--g-space-3); font-size: var(--text-heading); line-height: var(--text-heading--line-height); }
  h3 { margin: var(--g-space-6) 0 var(--g-space-2); font-size: var(--text-headingSm); line-height: var(--text-headingSm--line-height); }
  h4 { margin: var(--g-space-5) 0 var(--g-space-2); font-size: var(--text-bodyLg); line-height: var(--text-bodyLg--line-height); }
  h5, h6 { margin: var(--g-space-4) 0 var(--g-space-2); font-size: var(--text-body); line-height: var(--text-body--line-height); }
  p, ul, ol, blockquote, pre, table, figure { margin: 0 0 var(--g-space-4); }
  ul, ol { padding-inline-start: 1.5em; }
  li + li { margin-top: var(--g-space-1); }
  a { color: var(--g-accent-ink); text-underline-offset: 3px; pointer-events: none; }
  blockquote { padding: 2px 0 2px var(--g-space-4); border-inline-start: 2px solid var(--g-line-strong); color: var(--g-ink2); }
  blockquote > :last-child { margin-bottom: 0; }
  hr { height: 1px; margin: var(--g-space-6) 0; border: 0; background: var(--g-line); }
  :not(pre) > code { padding: 2px 5px; border-radius: var(--radius-chip); background: var(--g-inset); font: .9em/1.5 var(--font-mono); }
  pre { max-width: 100%; padding: var(--g-space-3) var(--g-space-4); overflow: auto; border: 1px solid var(--g-line); border-radius: var(--radius-control); background: var(--g-inset); color: var(--g-ink); font: var(--text-caption)/1.6 var(--font-mono); white-space: pre; }
  pre code { font: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-ui); }
  th, td { padding: var(--g-space-2); border: 1px solid var(--g-line); text-align: start; vertical-align: top; }
  th { background: var(--g-inset); font-weight: 600; }
  img { max-width: 100%; height: auto; }
  @media (max-width: 640px) { body { padding: var(--g-space-5) var(--g-space-4); } }
`;

/** The host sanitizes preview HTML. This frame adds fixed CSS and runs no document code. */
export function GardenMarkdownPreview({ html, title, theme }: { html: string; title: string; theme: Theme }) {
  // sandbox가 스크립트는 막지만 원격 하위 리소스는 막지 않으므로 CSP로 함께 차단한다.
  const srcDoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${html}<style data-garden-markdown-presentation>${gardenMarkdownScale}${gardenMarkdownPalettes[theme]}${presentation}</style>`;
  return <iframe title={`${title} 미리보기`} sandbox="" referrerPolicy="no-referrer" className="min-h-[65dvh] w-full rounded-control bg-surface" srcDoc={srcDoc}/>;
}
