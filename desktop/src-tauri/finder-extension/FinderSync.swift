import Cocoa
import FinderSync

class FinderSync: FIFinderSync {

    override init() {
        super.init()
        // Observe the entire filesystem so the context menu appears everywhere
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: "/")]
    }

    // MARK: - Context Menu

    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        let item = menu.addItem(
            withTitle: "Open in MeTerm",
            action: #selector(openInMeTerm(_:)),
            keyEquivalent: ""
        )
        item.image = NSImage(named: "MeTermIcon")
        return menu
    }

    @objc func openInMeTerm(_ sender: AnyObject?) {
        guard let items = FIFinderSyncController.default().selectedItemURLs(),
              !items.isEmpty else {
            // Background click — use the target directory
            if let target = FIFinderSyncController.default().targetedURL() {
                launchMeTerm(path: target.path)
            }
            return
        }

        // Use the first selected item
        let item = items[0]
        var isDir: ObjCBool = false
        let path: String
        if FileManager.default.fileExists(atPath: item.path, isDirectory: &isDir), isDir.boolValue {
            path = item.path
        } else {
            path = item.deletingLastPathComponent().path
        }
        launchMeTerm(path: path)
    }

    private func launchMeTerm(path: String) {
        // Find MeTerm.app — the extension lives inside it at Contents/PlugIns/
        let bundlePath = Bundle.main.bundlePath
        // MeTerm.app/Contents/PlugIns/MeTermFinder.appex → go up 3 levels
        let appURL: URL
        if let pluginsRange = bundlePath.range(of: "/Contents/PlugIns/") {
            let appPath = String(bundlePath[bundlePath.startIndex..<pluginsRange.lowerBound])
            appURL = URL(fileURLWithPath: appPath)
        } else {
            // Fallback: find by bundle ID
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.meterm.dev") {
                appURL = url
            } else {
                // Last resort: use open command
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                task.arguments = ["-b", "com.meterm.dev", "--args", path]
                try? task.run()
                return
            }
        }

        let config = NSWorkspace.OpenConfiguration()
        config.arguments = [path]
        config.activates = true

        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { _, error in
            if let error = error {
                NSLog("MeTermFinder: failed to launch MeTerm: \(error)")
            }
        }
    }
}
