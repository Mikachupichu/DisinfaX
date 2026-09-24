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

        // Before the app is running, because the first thing it can receive is a tap on its own
        // notification from a previous run's Notification Center.
        FactCheckNotifier.shared.start()

        NotificationCenter.default.addObserver(
            forName: .disinfaxBalanceRequested, object: nil, queue: .main
        ) { _ in
            // The notifier already activated the app; this is what puts a window in front of the
            // user, which activation alone does not do when the window is hidden or behind
            // another app's. Reuses the same path the popup's hand-off takes.
            Task { @MainActor in self.showMainWindow() }
        }

        installEditMenu()
    }

    /// Gives the app an Edit menu, which is what ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z were missing.
    ///
    /// Those are not text-view behaviours: every one of them is a key equivalent carried by an
    /// Edit menu item, and it is the item that routes `copy:`/`paste:` down the responder chain to
    /// whatever holds focus. The actions themselves are already implemented — they are `NSText`'s
    /// — so all that is needed is a menu item aimed at the first responder. With no Edit menu in
    /// the menu bar, the keystrokes do not exist at all: nothing in the app could be copied or
    /// pasted, the claim field included.
    ///
    /// `Main.storyboard`'s main menu is the app menu and Help, and nothing else — the template's
    /// File/Edit/View/Window menus were removed when the WKWebView it shipped with was replaced by
    /// SwiftUI. Built here rather than restored to the storyboard so that this and the accounts of
    /// why it is not in the storyboard stay in one place, and so nothing has to be reopened in
    /// Interface Builder to change a title or a shortcut.
    ///
    /// Undo and Redo are here for the same reason as the rest rather than because a field was
    /// reported broken: they are key equivalents the same missing menu carries, and with it gone
    /// there is no other menu in this app to carry them.
    private func installEditMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }

        let edit = NSMenu(title: String(localized: "Edit"))
        for item in Self.editMenuItems() { edit.addItem(item) }

        let item = NSMenuItem(title: String(localized: "Edit"), action: nil, keyEquivalent: "")
        item.submenu = edit
        // Position 1, directly after the app menu, which is where macOS puts it and where the
        // system's own Edit menu would be. Help is the only other menu and belongs last.
        mainMenu.insertItem(item, at: 1)
    }

    /// The standard Edit menu, in the standard order. Titles go through `NSLocalizedString` so
    /// they follow the app's translations where there are any, and read as English where there are
    /// not — the menu being English-only either way, as the storyboard's own items are.
    private static func editMenuItems() -> [NSMenuItem] {
        func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
            let item = NSMenuItem(title: NSLocalizedString(title, comment: "Standard Edit menu item"), action: action, keyEquivalent: key)
            item.target = nil // The first responder: the focused text view.
            return item
        }

        return [
            // `undo:` and `redo:` by name because they are not declared in Swift — the responder
            // chain resolves them to the focused view's undo manager, which is the point.
            item("Undo", Selector(("undo:")), "z"),
            // An uppercase key equivalent is Shift+⌘, which is how Redo is spelled everywhere.
            item("Redo", Selector(("redo:")), "Z"),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Delete", #selector(NSText.delete(_:)), ""),
            .separator(),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ]
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
        return true
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
