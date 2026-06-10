# CT General Statutes Explorer

`CT-Statutes` is a static, installable web application for browsing and searching the Connecticut General Statutes, the official subject index, and the Connecticut Judicial Branch's infractions schedule. The application uses plain HTML, CSS, and JavaScript, so it can be hosted on GitHub Pages or any other static web server. A service worker caches the application and statute data for offline use.

> [!IMPORTANT]
> This project is a research and access tool, not an official publication or a substitute for legal advice. Confirm statutory language, amendment history, effective dates, and monetary amounts with the linked Connecticut General Assembly and Connecticut Judicial Branch sources before relying on them.

## Features

- Browse statutes by title, chapter, and section.
- Search title and section metadata, infraction entries, or the full text of statutes.
- Browse the General Statutes subject index and follow its statute references and cross-references.
- Browse the infractions schedule by category and open matching statute sections when available.
- Bookmark sections in the browser.
- Adjust color theme, text size, and list density.
- Install the site as a Progressive Web App (PWA) and use previously downloaded content offline.

## Directory contents

| Path | Purpose |
| --- | --- |
| [`Index.html`](Index.html) | Application shell and accessible page structure. |
| [`app.js`](app.js) | Routing, data loading, search, rendering, bookmarks, and display settings. |
| [`styles.css`](styles.css) | Responsive layout, themes, controls, and print styles. |
| [`sw.js`](sw.js) | Service worker for application-shell and JSON data caching. |
| [`manifest.webmanifest`](manifest.webmanifest) | PWA metadata. |
| [`icon.svg`](icon.svg) | Site and installable-app icon. |
| [`data/`](data/) | Generated JSON consumed by the application. |
| [`ct_CGS_Crawl-v2.py`](ct_CGS_Crawl-v2.py) | Crawls current statute titles, chapters, sections, and full text from the Connecticut General Assembly. |
| [`parse_index.py`](parse_index.py) | Converts the three subject-index PDFs into `data/statutes_index.json`. |
| [`parse_infractions.py`](parse_infractions.py) | Converts the Judicial Branch schedule PDF into `data/infractions.json` and links entries to statute sections. |
| [`Index A-H.pdf`](Index%20A-H.pdf), [`Index I-S.pdf`](Index%20I-S.pdf), [`Index T-Z.pdf`](Index%20T-Z.pdf) | Source PDFs for the General Statutes subject index. |
| [`infractions_schedule.pdf`](infractions_schedule.pdf) | Source PDF for the infractions schedule. |

The scripts use paths relative to the current working directory. Run the data-generation commands from inside `CT-Statutes`.

## Run locally

The application must be served over HTTP; opening `Index.html` directly with a `file://` URL prevents normal `fetch` and service-worker behavior.

```bash
cd CT-Statutes
python -m http.server 8000
```

Open <http://localhost:8000/Index.html>. Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

Service workers can retain older files during development. If a change does not appear after reloading, use **Settings → Re-download data**, clear the site's storage in browser developer tools, or unregister the service worker.

## Data sources and generated files

The repository contains generated snapshots; it does not request statute content from Connecticut websites while a visitor browses the application.

| Generated file | Source | Contents |
| --- | --- | --- |
| `data/titles_index.json` | [Connecticut General Assembly current titles](https://www.cga.ct.gov/current/pub/titles.htm) | Lightweight list of titles and their per-title JSON filenames. |
| `data/title_XX.json` | Connecticut General Assembly title and chapter pages | A title's metadata, chapters, sections, full text, history, annotations, and repeal status when detected. Lettered titles use filenames such as `title_10a.json`. |
| `data/statutes_index.json` | [Legislative Commissioners' Office statutes index](https://www.cga.ct.gov/lco/statutes-index.asp) | Subject headings, nested entries, statute references, and “see” cross-references extracted from the three index PDFs. |
| `data/infractions.json` | [Connecticut Judicial Branch infractions schedule](https://www.jud.ct.gov/webforms/forms/infractions.pdf) | Violation descriptions, schedule categories, monetary columns, source-page numbers, and links to matching statute sections. |

The master generated datasets include source metadata. Check their `source.generated`, `source.revised`, or `source.effective` fields to determine the snapshot's date; do not infer currency from the repository's deployment date.

### Statute data shape

`titles_index.json` points to one file per title:

```json
{
  "source": "https://www.cga.ct.gov/current/pub/titles.htm",
  "titles": [
    {
      "title_key": "14",
      "label": "Title 14",
      "name": "Motor Vehicles. Use of the Highway By Vehicles. Gasoline",
      "url": "https://www.cga.ct.gov/current/pub/title_14.htm",
      "file": "title_14.json"
    }
  ]
}
```

A title file contains chapters, and each chapter contains sections:

```text
title
└── chapters[]
    └── sections[]
        ├── section_key, label, url
        └── content
            ├── body_paragraphs[]
            ├── source[]
            ├── history[]
            ├── annotations[]
            ├── text
            └── status (present when detected as repealed)
```

The application initially loads only the small master indexes. It fetches individual `title_XX.json` files as needed for browsing and progressively downloads them for full-text search.

### Subject-index data shape

`statutes_index.json` contains `headings[]`. Each heading has an `h` label and `items[]`; an item can contain:

- `l`: indentation level under the heading.
- `t`: display text with references removed.
- `r`: pairs of display citations and normalized base section keys.
- `see`: pairs of target headings and optional target subheadings.

### Infraction data shape

`infractions.json` contains `entries[]`. Important fields include:

- `stat_no`: citation as printed in the schedule.
- `citation`: cleaned citation for display.
- `section_key`: normalized base statute section.
- `description` and `category`: schedule text and grouping.
- `amounts`: available schedule columns, such as `total_due`, `fine`, `fee`, `cost`, and `surcharge`.
- `subsequent`: whether the schedule marks the row as a subsequent-offense entry.
- `page`: one-based source PDF page number.
- `ref`: matching `title_key` and `chapter_key`, when the statute crawler found the section.

## Refresh the data

### 1. Install parser dependencies

Python 3.10 or later is recommended.

```bash
cd CT-Statutes
python -m venv .venv
source .venv/bin/activate
python -m pip install requests beautifulsoup4 certifi pdfplumber
```

The virtual environment is local development state and should not be committed.

### 2. Crawl the statutes

Run the statute crawler first because the infractions parser uses statute files to create internal links.

```bash
python ct_CGS_Crawl-v2.py
```

The crawler rewrites `data/title_XX.json` and `data/titles_index.json`. It also writes `cgs_index.json` by default as a combined crawler result; that combined file is not used by the web application. Use `--out PATH` to put it elsewhere. Use `--sleep`, `--jitter`, and `--timeout` to tune request pacing and timeouts.

Be considerate of the Connecticut General Assembly's servers. Keep a delay between requests and avoid repeatedly running a full crawl during debugging.

### 3. Refresh and parse the subject index

Download the current three PDF ranges from the [official index page](https://www.cga.ct.gov/lco/statutes-index.asp), preserve these filenames, and replace the repository copies:

- `Index A-H.pdf`
- `Index I-S.pdf`
- `Index T-Z.pdf`

Then run:

```bash
python parse_index.py
```

The parser processes the files in parallel by default and writes `data/statutes_index.json`. For troubleshooting, `--serial` disables multiprocessing and `--limit N` parses only the first `N` pages of each PDF. A limited run is for debugging only and should not replace the committed complete index.

### 4. Refresh and parse the infractions schedule

Download the current [official infractions PDF](https://www.jud.ct.gov/webforms/forms/infractions.pdf) as `infractions_schedule.pdf`, then run:

```bash
python parse_infractions.py
```

This writes `data/infractions.json`. Run it after the statute crawl so its `ref` objects are built against the current title files.

### 5. Review generated changes

Generated data can be large. Review source metadata, record counts, parser output, and a sample of entries before committing it:

```bash
python -m json.tool data/titles_index.json >/dev/null
python -m json.tool data/statutes_index.json >/dev/null
python -m json.tool data/infractions.json >/dev/null
find data -name 'title_*.json' -print0 | xargs -0 -n1 python -m json.tool >/dev/null
git diff --stat
git status --short
```

Also test representative navigation and searches in a browser, including:

- a numeric citation and a keyword search;
- full-text search after all titles finish downloading;
- a subject-index cross-reference;
- an infraction linked to a statute;
- a repealed section;
- offline reload after the data has been cached.

## Application architecture

### Routes

The single-page application uses URL hashes, allowing deep links to work on static hosting without server-side route configuration:

| Route | View |
| --- | --- |
| `#/` | Title browser |
| `#/t/{title}` | Chapters in a title |
| `#/t/{title}/c/{chapter}` | Sections in a chapter |
| `#/t/{title}/c/{chapter}/s/{section}` | Statute section |
| `#/x` | Subject index |
| `#/i` | Infractions schedule |
| `#/b` | Bookmarks |

More specific subject-index and infraction routes are generated internally by `app.js`.

### Browser storage

Bookmarks and display preferences are browser-local and are not synchronized to a server. The application uses these `localStorage` keys:

- `cgs:bookmarks:v1`
- `cgs:theme`
- `cgs:textsize`
- `cgs:density`

Clearing browser site data removes these preferences and bookmarks.

### Offline caching

`sw.js` uses two caches:

- `cgs-shell-v1` uses a network-first strategy for HTML, CSS, JavaScript, the manifest, and the icon.
- `cgs-data-v1` uses a cache-first strategy for files under `data/`.

The cache names in `sw.js` and `app.js` must stay synchronized. When a change requires all clients to discard old cached resources, increment the relevant cache version. The **Re-download data** setting clears the data cache and reloads the application.

## Deployment

All runtime assets are static. Deploy the `CT-Statutes` directory without a build step and preserve its relative paths. The host must:

- serve the files over HTTPS in production so the service worker can register;
- serve JSON, JavaScript, CSS, SVG, PDF, and web-manifest files with appropriate content types;
- preserve filename case, including `Index.html`;
- keep the application and `data/` directory under the same origin and path scope.

After deployment, load the site online once to populate the shell cache. Individual title files become available offline after they have been opened or downloaded for full-text search.

## Maintenance notes

- Treat files under `data/` as generated artifacts; update their generating script rather than hand-editing many records.
- Keep the source PDFs with the generated JSON so extraction results can be reproduced and audited.
- PDF layouts can change without notice. A parser that completes successfully can still produce incorrect columns or grouping, so spot-check output after every source-PDF update.
- Changing data structures requires corresponding updates in `app.js` and this README.
- Changing cached asset names or adding shell assets may require updating `SHELL_ASSETS` in `sw.js`.
- Do not commit virtual environments, temporary combined crawler output, Python bytecode, or local server files.
