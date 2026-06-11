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


# CT General Statutes Explorer — System Documentation

## 1. Overview

The CT General Statutes Explorer is a static, browser-based web application for browsing and searching the Connecticut General Statutes, the official subject index, and the Connecticut Judicial Branch infraction schedule.

The application is designed to run from GitHub Pages with no server-side backend. It loads pre-generated JSON files from the local `data/` directory, renders the interface in the browser, and supports offline use through a service worker.

## 2. Primary Functions

The application allows users to:

* Browse Connecticut General Statutes by Title, Chapter, and Section.
* Search by keyword, statute number, or Boolean query.
* Search statute labels and, after title data loads, full statute text.
* Browse the official subject index by letter and heading.
* Browse the infraction and violation schedule by category.
* Link infraction entries back to their related statute sections when available.
* Bookmark statutes and infractions on the user’s device.
* View recently accessed statutes and infractions.
* Share statute sections or infractions by email, native share, or copied link.
* Use the application offline after the data has been cached.

## 3. Technology Stack

### Front End

* HTML
* CSS
* Vanilla JavaScript
* Hash-based routing
* Browser `fetch()` API
* Browser `localStorage`
* Browser Cache Storage API
* Service Worker
* Web App Manifest

### Data Generation

* Python
* `requests`
* `beautifulsoup4`
* `certifi`
* `pdfplumber`

### Hosting

* GitHub Pages
* Static files served directly from the repository

No build process, package manager, database, authentication system, or server runtime is required for the deployed application.

## 4. Folder Structure

```text
Pages/Work/cgs/
├── index.html
├── styles.css
├── app.js
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── ct_CGS_Crawl-v2.py
├── parse_index.py
├── parse_infractions.py
└── data/
    ├── titles_index.json
    ├── title_01.json
    ├── title_02.json
    ├── ...
    ├── statutes_index.json
    └── infractions.json
```

## 5. File Responsibilities

### `index.html`

Defines the static application shell. It includes the document metadata, manifest link, icon, stylesheet, header navigation, search controls, settings panel, navigation pane, main content pane, and the script tag that loads `app.js`.

The interface has four primary areas:

* Browse
* Index
* Infractions
* Bookmarks

It also includes user settings for theme, text size, compact list density, data refresh, and bookmark clearing.

### `styles.css`

Controls the visual design, responsive layout, light/dark theme support, compact density mode, cards, lists, panels, buttons, breadcrumbs, search results, and mobile behavior.

The stylesheet uses CSS variables for theme colors and supports:

* System theme detection
* Explicit light mode
* Explicit dark mode
* Text-size scaling
* Compact list density
* Sticky header
* Sidebar/content layout
* Mobile-focused content views

### `app.js`

Contains the main application logic.

Major responsibilities include:

* Application configuration
* Runtime state management
* DOM references
* Hash-based routing
* Settings management
* Bookmark storage
* Recently viewed storage
* Share link generation
* JSON loading
* Title preloading
* Search parsing and evaluation
* Rendering of Browse, Index, Infractions, Bookmarks, and Search views
* Service worker registration
* Event binding

Important data files loaded by `app.js`:

```text
./data/titles_index.json
./data/title_XX.json
./data/infractions.json
./data/statutes_index.json
```

### `sw.js`

Provides offline support.

The service worker uses two cache buckets:

```text
cgs-shell-v1
cgs-data-v1
```

Shell assets are cached with a network-first strategy so updated deployments can take effect on reload. JSON data files are cached with a cache-first strategy because statute data is large and changes less frequently.

The app’s “Re-download data” button clears the data cache and reloads the page.

### `manifest.webmanifest`

Defines the Progressive Web App metadata, including:

* App name
* Short name
* Description
* Start URL
* Scope
* Display mode
* Theme color
* Background color
* Icon

### `icon.svg`

The application icon used by the browser, manifest, and Apple touch icon reference.

### `ct_CGS_Crawl-v2.py`

Crawls the current Connecticut General Statutes from the Connecticut General Assembly website.

The script starts from the current titles page and traverses:

```text
Titles → Chapters → Sections
```

It generates:

```text
data/titles_index.json
data/title_XX.json
```

Each title is written as a separate JSON file so the browser can load statute data incrementally instead of loading the entire corpus at once.

### `parse_index.py`

Parses the official Legislative Commissioners’ Office subject index PDFs.

Expected input files:

```text
Index A-H.pdf
Index I-S.pdf
Index T-Z.pdf
```

Generated output:

```text
data/statutes_index.json
```

The output organizes subject headings, entries, statute references, indentation levels, and “See” cross-references.

### `parse_infractions.py`

Parses the Connecticut Judicial Branch infractions schedule PDF.

Expected input file:

```text
infractions_schedule.pdf
```

Generated output:

```text
data/infractions.json
```

Each row in the schedule becomes an infraction entry with citation, base statute section, description, amount columns, category, page number, and a statute reference when the matching section exists in the generated statute data.

## 6. Data Model

### `titles_index.json`

The master statute index contains source metadata and a lightweight list of titles.

Each title entry includes:

```json
{
  "title_key": "14",
  "label": "Title 14",
  "name": "Motor Vehicles. Use of the Highway By Vehicles. Gasoline",
  "url": "https://www.cga.ct.gov/current/pub/title_14.htm",
  "file": "title_14.json"
}
```

The application loads this file first, then loads individual title files as needed.

### `title_XX.json`

Each title file contains one full title.

Simplified structure:

```json
{
  "title_key": "48",
  "label": "Title 48",
  "name": "Eminent Domain",
  "url": "https://www.cga.ct.gov/current/pub/title_48.htm",
  "chapters": [
    {
      "chapter_key": "835",
      "label": "Chapter 835",
      "name": "Eminent Domain",
      "url": "https://www.cga.ct.gov/current/pub/chap_835.htm",
      "sections": [
        {
          "section_key": "48-1",
          "label": "Sec. 48-1. ...",
          "url": "https://www.cga.ct.gov/current/pub/chap_835.htm#sec_48-1",
          "content": {
            "body_paragraphs": [],
            "source": [],
            "history": [],
            "annotations": [],
            "text": ""
          }
        }
      ]
    }
  ]
}
```

### `statutes_index.json`

The subject index contains source metadata and a list of headings.

Simplified structure:

```json
{
  "source": {
    "url": "https://www.cga.ct.gov/lco/statutes-index.asp",
    "title": "Index to the General Statutes of Connecticut",
    "publisher": "Connecticut General Assembly, Legislative Commissioners' Office",
    "revised": "Revision of 1958, revised to January 1, 2025",
    "generated": "YYYY-MM-DD"
  },
  "headings": [
    {
      "h": "ABANDONMENT",
      "items": [
        {
          "l": 0,
          "t": "Aircraft",
          "r": [["15-76", "15-76"]]
        }
      ]
    }
  ]
}
```

Field meanings:

```text
h    Subject heading
items    Entries under the heading
l    Indentation level
t    Entry text
r    Statute references
see  Cross-references to other headings
```

### `infractions.json`

The infraction schedule contains source metadata and parsed infraction entries.

Simplified structure:

```json
{
  "source": {
    "url": "https://www.jud.ct.gov/webforms/forms/infractions.pdf",
    "title": "Mail-In Violations and Infractions Schedule (Chart A)",
    "publisher": "State of Connecticut Judicial Branch",
    "effective": "October 1, 2025",
    "generated": "YYYY-MM-DD"
  },
  "entries": [
    {
      "stat_no": "13b-29",
      "citation": "13b-29",
      "section_key": "13b-29",
      "description": "Violation of regulations for commuter parking facilities",
      "amounts": {
        "total_due": 75.0,
        "fine": 35.0,
        "fee": 5.0,
        "surcharge": 35.0
      },
      "category": "MOTOR VEHICLES",
      "subsequent": false,
      "page": 6,
      "ref": {
        "title_key": "13b",
        "chapter_key": "242"
      }
    }
  ]
}
```

## 7. Application Flow

### Initial Page Load

1. `index.html` loads.
2. Saved display settings are applied early to prevent a visual flash.
3. `styles.css` loads.
4. `app.js` loads.
5. Bookmarks and recently viewed items are read from `localStorage`.
6. Settings and event handlers are initialized.
7. The service worker is registered when supported.
8. The app loads `titles_index.json` and `infractions.json`.
9. The current route is rendered.
10. `statutes_index.json` loads asynchronously.
11. All title files begin preloading in the background for offline use and full-text search.

### Routing

The application uses URL hash routes.

Common routes:

```text
#/                                      Home
#/titles                                All titles
#/t/{titleKey}                          Title view
#/t/{titleKey}/c/{chapterKey}           Chapter view
#/t/{titleKey}/c/{chapterKey}/s/{sec}   Section view
#/x                                     Subject index
#/x/l/{letter}                          Subject index letter
#/x/h/{headingSlug}                     Subject index heading
#/i                                     Infractions overview
#/i/c/{categorySlug}                    Infraction category
#/i/e/{infractionId}                    Infraction detail
#/b                                     Bookmarks
```

### Search

The search box supports two scopes:

```text
Titles, sections & infractions
Full text of statutes
```

Search supports:

* Statute number lookup
* Keyword search
* Exact phrases in quotation marks
* Boolean `AND`
* Boolean `OR`
* Boolean `NOT`
* Leading minus sign for exclusion
* Parentheses for grouping

Examples:

```text
14-296aa
dog NOT license
leash OR muzzle
"evading responsibility"
(dog OR cat) AND bite
-license
```

Operators must be capitalized to be treated as Boolean operators.

### Full-Text Search Behavior

Full-text search runs against title data that has already loaded into memory. Because the app preloads all title files in the background, results may grow while the preload process continues.

Users can also force a title to load by browsing to that title.

## 8. Offline Behavior

The service worker caches:

```text
Shell files:
- index.html
- styles.css
- app.js
- manifest.webmanifest
- icon.svg

Data files:
- data/*.json
```

Shell files use a network-first strategy. This allows new deployments to appear after reload.

Data files use a cache-first strategy. This improves offline performance but means updated JSON may not appear until the data cache is cleared.

The settings panel includes a “Re-download data” button that deletes the `cgs-data-v1` cache and reloads the app.

When changing the data cache strategy or cache version, keep the cache name in `app.js` and `sw.js` synchronized.

## 9. Local Development

### Requirements

Install Python dependencies:

```bash
pip install requests beautifulsoup4 certifi pdfplumber
```

### Run Locally

Because the app uses `fetch()` and a service worker, use a local web server instead of opening `index.html` directly with `file://`.

From the repository root:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/Pages/Work/cgs/
```

### Notes

* Service workers do not work from `file://`.
* Some browser caching behavior may differ between localhost and GitHub Pages.
* The app uses relative paths, so it should work as long as the folder structure is preserved.

## 10. Data Refresh Procedure

### Refresh Statute Data

From `Pages/Work/cgs/`:

```bash
python ct_CGS_Crawl-v2.py --sleep 0.3 --jitter 0.2 --timeout 30
```

This regenerates:

```text
data/titles_index.json
data/title_XX.json
```

### Refresh Subject Index Data

Download the current index PDFs from the Legislative Commissioners’ Office source page and place them in the `Pages/Work/cgs/` folder with these exact filenames:

```text
Index A-H.pdf
Index I-S.pdf
Index T-Z.pdf
```

Then run:

```bash
python parse_index.py
```

This regenerates:

```text
data/statutes_index.json
```

For debugging, parse only the first few pages:

```bash
python parse_index.py --limit 5 --serial
```

### Refresh Infraction Schedule Data

Download the current infractions schedule PDF and save it as:

```text
infractions_schedule.pdf
```

Then run:

```bash
python parse_infractions.py
```

This regenerates:

```text
data/infractions.json
```

Run the statute crawler before parsing infractions so the infraction parser can link entries back to statute sections.

## 11. Deployment

The app is deployed as static files through GitHub Pages.

Basic deployment process:

1. Refresh or edit files locally.
2. Test with a local web server.
3. Confirm that JSON files load successfully.
4. Commit the updated files.
5. Push to the GitHub Pages branch/source used by the repository.
6. Open the deployed page and test navigation, search, index, infractions, bookmarks, and offline behavior.

Because the service worker caches data aggressively, use the app’s “Re-download data” button after major data updates.

## 12. Validation Checklist

After refreshing data or changing code, test the following:

* Home page loads without errors.
* Browse tab displays the title list.
* A title opens and displays chapters.
* A chapter opens and displays sections.
* A statute section opens and shows body text.
* Source, history, annotations, and repealed sections display correctly where present.
* Subject index loads.
* Subject index headings link to statute sections when matching data exists.
* Infractions overview loads.
* Infraction categories display entries.
* Infraction detail pages show fine amounts.
* Infraction entries link back to statute sections when available.
* Search works for a statute number such as `14-296aa`.
* Keyword search returns sections, topics, chapters, titles, and infractions where applicable.
* Full-text search returns results after title preloading has progressed.
* Bookmarks can be added and removed.
* Recently viewed items appear on the home page.
* Theme, text size, and compact mode persist after reload.
* Re-download data clears stale cached JSON.
* The app still works after going offline once data has loaded.

## 13. Troubleshooting

### App shows “Failed to load data”

Check that:

* `data/titles_index.json` exists.
* The path is exactly correct, including capitalization.
* The app is being served over HTTP/HTTPS, not opened as a local file.
* GitHub Pages has finished deploying.
* The browser console does not show a 404 for JSON files.

### Updated statute data is not appearing

Try:

1. Open Settings.
2. Click “Re-download data.”
3. Reload the page.

If that does not work, clear site data in the browser or bump the data cache version in both `app.js` and `sw.js`.

### Full-text search seems incomplete

Full-text search only covers title files that have loaded into memory. Wait for background preloading to finish, or browse directly to the relevant title to load it.

### Subject index does not load

Check that:

* `data/statutes_index.json` exists.
* The index PDFs were downloaded with the expected filenames.
* `parse_index.py` completed without errors.
* The JSON file is valid.

### Infractions do not link to statute sections

Check that:

* The statute crawler was run before `parse_infractions.py`.
* The matching title JSON files exist in `data/`.
* The `section_key` normalization in the infraction output matches the statute section keys.
* The infraction source PDF has not changed layout in a way that affects parsing.

### Offline mode does not work locally

Use `localhost` instead of opening the file directly. Service workers do not run from `file://`.

### New JavaScript or CSS is not appearing

The shell cache is network-first, but a hard refresh may still help. Try:

* Hard refresh.
* Close and reopen the tab.
* Clear site data.
* Bump `cgs-shell-v1` in `sw.js` if needed.

## 14. Maintenance Notes

Recommended maintenance cycle:

* Refresh statute data after official CGA updates.
* Refresh the subject index when the LCO publishes a new revised index.
* Refresh infractions whenever the Judicial Branch publishes a new effective schedule.
* Confirm generated dates and effective dates in JSON metadata.
* Validate output files before deployment.
* Keep `DATA_CACHE` in `app.js` and `sw.js` synchronized.
* Consider adding a small validation script to check for empty JSON files, malformed JSON, missing title files, and broken infraction references.

## 15. Privacy and Security

The application does not require a backend, login, database, or third-party analytics.

Data stored on the user’s device:

* Bookmarks
* Recently viewed items
* Theme preference
* Text-size preference
* Compact-density preference
* Cached statute/index/infraction JSON files

No user search queries, bookmarks, or reading history are transmitted to a server by the application itself.

## 16. Known Limitations

* Full-text search depends on title files being loaded or preloaded.
* Offline data may become stale until the data cache is cleared.
* PDF parsing can break if the source PDF layouts change.
* The app relies on official source pages remaining structurally consistent.
* The application presents legal information but should not be treated as legal advice.
* Subject index references can only link to statute sections that exist in the loaded/generated statute data.

## 17. Future Improvements

Potential improvements:

* Add a visible “data last updated” section to the home page.
* Add a validation script for generated JSON.
* Add a GitHub Action for data validation on commit.
* Add a `README.md` directly inside `Pages/Work/cgs/`.
* Add a plain-language disclaimer and official-source note.
* Add a “clear all site data” troubleshooting button.
* Add automated checks for broken statute links.
* Add a changelog for data refreshes.
* Add a small admin checklist for annual or session-based updates.
