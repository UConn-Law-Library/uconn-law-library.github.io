# CT Statutes — iOS App

The iOS counterpart to [`../android-app`](../android-app/README.md): a standalone app that packages the [CT General Statutes Explorer](../README.md) web application. The complete HTML/CSS/JavaScript shell **and every JSON data file** ship inside the app bundle, so it works entirely offline and never touches the network.

## How it works

- A SwiftUI shell hosts a single `WKWebView`. `fetch()` cannot read `file://` URLs in WKWebView, so a `WKURLSchemeHandler` serves the bundled files at the custom origin `ctstatutes://localhost/` — `fetch()` and `localStorage` (bookmarks, recents, display settings) work normally there.
- `app.js` recognizes the `ctstatutes:` protocol as a packaged app: it rewrites share links to the public GitHub Pages site, hides the download/refresh settings, skips the service worker, and auto-indexes all titles at launch so subject-index links and full-text search work with no manual step.
- Links leaving the app origin (statute sources on `cga.ct.gov`, `mailto:` shares) open in Safari / Mail. Swipe-from-edge navigates back through in-app history.
- The web assets are copied from the parent `CT-Statutes/` directory by the *Copy web app and statute data* build phase, so the app always packages whatever is currently in `CT-Statutes/` and `CT-Statutes/data/` — nothing to copy by hand.

## Building

**On a Mac:** open `CTStatutes.xcodeproj` in Xcode 15+, select your team under *Signing & Capabilities*, and Run. A free Apple ID works for personal installs (apps expire after 7 days and must be re-run from Xcode; a paid Apple Developer account removes that limit).

**Without a Mac:** the workflow [`.github/workflows/build-ios-app.yml`](../../.github/workflows/build-ios-app.yml) builds an **unsigned** IPA on a GitHub macOS runner (runs automatically when `ios-app/` changes, or trigger it from the Actions tab). Download the `ctstatutes-unsigned-ipa` artifact, then sign and install it from Windows with [Sideloadly](https://sideloadly.io/) or [AltStore](https://altstore.io/) using your Apple ID. The same 7-day expiry applies with a free Apple ID (AltStore can auto-refresh).

Unlike Android, iOS has no general "install from unknown sources" — every install must be signed against an Apple ID, which is why the CI artifact is unsigned.

## Updating the statute data

Data is baked into the bundle. After refreshing `CT-Statutes/data/` (see the [data refresh procedure](../README.md#refresh-the-data)), rebuild; bump `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in the project settings for a distributable update.
