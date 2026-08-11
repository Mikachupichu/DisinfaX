//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Michaël Pouget on 2026-08-07.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Must be running before any purchase, not after: transactions that complete outside a
        // purchase() call — Ask to Buy approvals, SCA challenges finished elsewhere, Apple's own
        // retries — are delivered only to this listener, and are lost if nothing is listening.
        if #available(macOS 12.0, *) {
            StoreKitManager.shared.startObservingTransactionUpdates()
        }
    }

    /// Silences the runtime warning about restorable state, and opts in to the secure coding it
    /// asks for. Nothing here archives untrusted state, so there is nothing to migrate.
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }

    /// Was `true`, which quit the app the moment its window closed. That is wrong now that the
    /// app performs purchases: StoreKit's sheet and the transaction that follows need the process
    /// alive, and a user who closes the window mid-purchase would otherwise kill it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    /// Entry point for `disinfax://topup?amount=N`, opened by the Safari extension popup. The
    /// scheme is already declared in macOS (App)/Info.plist (CFBundleURLTypes); without this
    /// method the app would launch and then ignore the request entirely.
    func application(_ application: NSApplication, open urls: [URL]) {
        var handled = false
        for url in urls where TopUpHandoff.handle(url) { handled = true }
        guard handled else { return }

        // Showing a window is not optional here. Because the app no longer quits with its last
        // window (see above), it can be running with nothing on screen — and then a hand-off
        // delivered the URL, TopUpView was rebuilt, and absolutely nothing appeared. From the
        // user's side the Top Up button simply did nothing.
        showMainWindow()
    }

    /// Also covers clicking the Dock icon while the app is running windowless, which would
    /// otherwise be just as dead an end as the hand-off was.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    /// Retained because instantiating from the storyboard creates a controller that owns the
    /// window; without a strong reference it would be released and the window would close again
    /// on the next run loop pass.
    private var reopenedWindowController: NSWindowController?

    private func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)

        // Prefer a window that already exists — a hidden or merely backgrounded one just needs
        // ordering front, and rebuilding it instead would discard whatever the user had typed.
        if let existing = NSApp.windows.first(where: { $0.canBecomeMain }) {
            existing.makeKeyAndOrderFront(nil)
            return
        }

        // Nothing left to show: the window was closed, so rebuild it from the storyboard that
        // NSApplication used at launch.
        let controller = NSStoryboard(name: "Main", bundle: nil).instantiateInitialController() as? NSWindowController
        guard let controller else { return }
        reopenedWindowController = controller
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
    }

}
