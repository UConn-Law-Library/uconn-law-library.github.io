# uconn-law-library.github.io

The current Connecticut General Statutes app is published at
[https://uconn-law-library.github.io/CGS/](https://uconn-law-library.github.io/CGS/)
from the [CGS repository](https://github.com/UConn-Law-Library/CGS).

The legacy `CT-Statutes/index.html` and `CT-Statutes/next/index.html` redirect
visitors to the current app's home page, including visits using old hash links.
Legacy routes are not carried over because the apps use different route formats.
Each page provides a normal link and a no-JavaScript refresh fallback.

Keep both legacy `sw.js` files available at their original URLs. They replace
installed service workers, unregister themselves, and move open legacy tabs to
CGS when the browser receives the update online. Existing offline installations
cannot receive this change until they reconnect. The retirement workers leave
Cache Storage and localStorage intact, preserving browser data and avoiding
interference with the current CGS app.

The remaining legacy sources and data are retained for reference. Deployment is
handled by the existing Pages workflow after changes are merged into `main`.
