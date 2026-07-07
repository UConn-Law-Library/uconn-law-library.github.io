import SwiftUI
import WebKit

/// The CT General Statutes Explorer web app — shell and all statute JSON —
/// ships in the app bundle under `www/` and is served to the WKWebView
/// through a custom URL scheme, so the app works with no network access.
/// (`fetch()` cannot read `file://` URLs in WKWebView, hence the scheme
/// handler; `app.js` recognizes the `ctstatutes:` protocol as the packaged
/// app and adjusts sharing links and preloading behavior.)
private let appScheme = "ctstatutes"
private let startURL = URL(string: "\(appScheme)://localhost/index.html")!

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: appScheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.load(URLRequest(url: startURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme == appScheme {
                decisionHandler(.allow) // in-app navigation
                return
            }
            // Statute sources on cga.ct.gov, mailto: shares, etc.
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}

/// Serves files from the bundle's `www/` directory for
/// `ctstatutes://localhost/...` requests (page loads and `fetch()`).
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        guard let www = Bundle.main.resourceURL?.appendingPathComponent("www"),
              let data = try? Data(contentsOf:
                  www.appendingPathComponent(String(path.dropFirst()))) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType(forExtension: (path as NSString).pathExtension),
                "Content-Length": String(data.count),
            ])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "webmanifest": return "application/manifest+json"
        default: return "application/octet-stream"
        }
    }
}
