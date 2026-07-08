---
name: verify
description: Build/launch/drive recipe for verifying CT-Statutes changes (static web app + Python crawler).
---

# Verifying CT-Statutes changes

The web app is fully static: `index.html` + `app.js` fetch `data/*.json`, so it
must be served over HTTP (file:// fails). Serve with:

```
python -m http.server <port> --directory CT-Statutes
```

(or via `.claude/launch.json` + the preview tools, config name `ct-statutes`).

## Driving the app

- Routes are hash-based: `#/t/<title_key>` (e.g. `42a`), `#/t/<t>/c/<chapter_key>`
  (e.g. `247`, or `art_001` for UCC articles), `#/t/<t>/c/<c>/s/<section_key>`
  (e.g. `14-167`, `42a-1-201`). Set `location.hash` directly to navigate.
- Search: fill the single `input` element and dispatch an `input` event; results
  render as `a.card` elements after a ~500ms debounce.
- In-text statute citations render as `<a href="#/t/.../s/...">` inside the
  section body; cross-references appear as `details.xref` panels.

## Crawler (ct_CGS_Crawl-v2.py)

- Run from inside `CT-Statutes/` (it writes `data/` relative to CWD).
- `--titles 42a,42b` crawls only those titles and leaves `titles_index.json`
  untouched; pass `--out <scratch path>` to keep the summary JSON out of the repo.
- Needs `truststore` installed (cga.ct.gov omits its intermediate certificate;
  certifi alone fails TLS verification).
- Quick regression check: crawl a small title (e.g. `--titles 42b,4e`) and
  `git diff` the data files — output should be byte-identical unless the
  statutes actually changed upstream.
