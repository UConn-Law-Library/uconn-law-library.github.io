# CT Statutes — Android App

A standalone Android app that packages the [CT General Statutes Explorer](../README.md) web application. The complete HTML/CSS/JavaScript shell **and every JSON data file** (all statute titles, the subject index, and the infractions schedule) are bundled inside the APK, so the installed app works entirely offline and requests **no permissions** — it never touches the network.

## How it works

- `MainActivity` hosts a single `WebView` and serves the bundled files through [`WebViewAssetLoader`](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader) at the virtual origin `https://appassets.androidplatform.net/`. That origin is a secure context, so `fetch()` and `localStorage` (bookmarks, recents, display settings) behave exactly as they do on the hosted site.
- The web app's own share logic already detects this origin and generates share links that point to the public site, so links shared from the app open for anyone.
- Links leaving the app origin — statute source pages on `cga.ct.gov`, `mailto:` shares — are handed to the system browser or mail app.
- `sw.js` (the PWA service worker) is intentionally **not** bundled; inside the app every file is already local, so the offline-caching layer is unnecessary.
- The system Back gesture/button walks the WebView history before exiting the app.

## Building

The web assets are copied from the parent `CT-Statutes/` directory at build time by the `syncWebAssets` Gradle task (see `app/build.gradle`), so there is nothing to copy or regenerate by hand — the APK always packages whatever is currently in `CT-Statutes/` and `CT-Statutes/data/`.

Requirements: JDK 17 and the Android SDK (platform 36, build-tools 36). Point `local.properties` at your SDK (`sdk.dir=...`) or set `ANDROID_HOME`.

```bash
cd CT-Statutes/android-app
./gradlew assembleDebug     # installable, debug-signed APK
./gradlew assembleRelease   # unsigned release APK (must be signed before install)
```

Outputs land in `app/build/outputs/apk/`. The debug APK (`app-debug.apk`) can be sideloaded directly onto a device ("install from unknown sources").

### Signing a release build

For distribution, create a keystore once and add a `signingConfig`, or sign manually:

```bash
keytool -genkeypair -v -keystore ctstatutes.keystore -alias ctstatutes \
    -keyalg RSA -keysize 2048 -validity 10000
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign --ks ctstatutes.keystore \
    --out app-release-signed.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

## Updating the statute data

Statute data is baked into the APK. After refreshing `CT-Statutes/data/` (see the [data refresh procedure](../README.md#refresh-the-data)), rebuild the APK and bump `versionCode`/`versionName` in `app/build.gradle` so devices treat it as an update.

## CI builds

The workflow [`.github/workflows/build-android-app.yml`](../../.github/workflows/build-android-app.yml) builds the debug APK on GitHub-hosted runners. Trigger it manually from the repository's **Actions** tab (*Build CT-Statutes Android app → Run workflow*) and download the APK from the run's artifacts.
