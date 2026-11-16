export const artifactPolicy = [
  'sandbox allow-scripts allow-forms allow-modals allow-downloads',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: http: blob: data:",
  "style-src 'unsafe-inline' https: http: blob: data:",
  'img-src https: http: blob: data:',
  'font-src https: http: data:',
  'media-src https: http: blob: data:',
  'connect-src https: http: wss: ws:',
  'frame-src https: http:',
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

export function renderArtifact({ id, html, css, js }) {
  const style = css ? `<link rel="stylesheet" href="/a/${id}/style.css">` : '';
  const script = js ? `<script defer src="/a/${id}/script.js"></script>` : '';
  let document = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
  document = /<\/head\s*>/i.test(document) ? document.replace(/<\/head\s*>/i, `${style}</head>`) : style + document;
  return /<\/body\s*>/i.test(document) ? document.replace(/<\/body\s*>/i, `${script}</body>`) : document + script;
}
