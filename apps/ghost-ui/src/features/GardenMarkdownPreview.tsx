type Theme = 'light' | 'dark';

const gardenMarkdownStyles: Record<Theme, string> = {
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
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      --text-body: 14px;
      --text-body-leading: 1.5;
      --text-heading-lg: 24px;
      --text-heading: 20px;
      --text-heading-sm: 18px;
      --g-layout-document-max: 760px;
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
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      --text-body: 14px;
      --text-body-leading: 1.5;
      --text-heading-lg: 24px;
      --text-heading: 20px;
      --text-heading-sm: 18px;
      --g-layout-document-max: 760px;
    }
  `,
};

const presentation = `
  html { background: var(--g-canvas); }
  body {
    box-sizing: border-box;
    width: min(100%, calc(var(--g-layout-document-max) + 64px));
    margin: 0 auto;
    padding: 32px;
    background: var(--g-canvas);
    color: var(--g-ink);
    font: var(--text-body)/var(--text-body-leading) var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  h1, h2, h3, h4, h5, h6 { color: var(--g-ink); font-weight: 600; letter-spacing: -.02em; }
  h1 { margin: 0 0 24px; font-size: var(--text-heading-lg); line-height: 1.3; letter-spacing: -.025em; }
  h2 { margin: 28px 0 12px; font-size: var(--text-heading); line-height: 1.35; }
  h3 { margin: 24px 0 10px; font-size: var(--text-heading-sm); line-height: 1.4; }
  h4 { margin: 20px 0 8px; font-size: 16px; line-height: 1.5; }
  h5, h6 { margin: 18px 0 8px; font-size: 14px; line-height: 1.5; }
  p, ul, ol, blockquote, pre, table, figure { margin: 0 0 16px; }
  ul, ol { padding-inline-start: 1.5em; }
  li + li { margin-top: 4px; }
  a { color: var(--g-accent-ink); text-underline-offset: 3px; pointer-events: none; }
  blockquote { padding: 2px 0 2px 16px; border-inline-start: 2px solid var(--g-line-strong); color: var(--g-ink2); }
  blockquote > :last-child { margin-bottom: 0; }
  hr { height: 1px; margin: 24px 0; border: 0; background: var(--g-line); }
  :not(pre) > code { padding: 2px 5px; border-radius: 5px; background: var(--g-inset); font: .9em/1.5 var(--font-mono); }
  pre { max-width: 100%; padding: 14px 16px; overflow: auto; border: 1px solid var(--g-line); border-radius: 8px; background: var(--g-inset); color: var(--g-ink); font: 12px/1.6 var(--font-mono); white-space: pre; }
  pre code { font: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 10px; border: 1px solid var(--g-line); text-align: start; vertical-align: top; }
  th { background: var(--g-inset); font-weight: 600; }
  img { max-width: 100%; height: auto; }
  @media (max-width: 640px) { body { padding: 20px 16px; } }
`;

/** The host sanitizes preview HTML. This frame adds fixed CSS and runs no document code. */
export function GardenMarkdownPreview({ html, title, theme }: { html: string; title: string; theme: Theme }) {
  // sandbox가 스크립트는 막지만 원격 하위 리소스는 막지 않으므로 CSP로 함께 차단한다.
  const srcDoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${html}<style data-garden-markdown-presentation>${gardenMarkdownStyles[theme]}${presentation}</style>`;
  return <iframe title={`${title} 미리보기`} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc}/>;
}
