import SwiftUI

@main
struct CTStatutesApp: App {
    var body: some Scene {
        WindowGroup {
            ZStack {
                // Brand color fills the status bar / home indicator areas
                // outside the safe area, matching the web app's header.
                Color(red: 0x1E / 255, green: 0x3A / 255, blue: 0x8A / 255)
                    .ignoresSafeArea()
                WebView()
            }
        }
    }
}
