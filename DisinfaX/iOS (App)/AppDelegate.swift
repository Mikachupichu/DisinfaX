//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Michaël Pouget on 2026-08-07.
//

import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Must be running before any purchase, not after: transactions that complete outside a
        // purchase() call — Ask to Buy approvals, SCA challenges finished elsewhere, Apple's own
        // retries — are delivered only to this listener, and are lost if nothing is listening.
        if #available(iOS 15.0, *) {
            StoreKitManager.shared.startObservingTransactionUpdates()
        }

        // Before the app is running, because the first thing it can receive is a tap on its own
        // notification from a previous run's Notification Center. On iOS that tap also brings the
        // app forward, so the tab is the only thing the delegate has to arrange.
        FactCheckNotifier.shared.start()
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    /// Portrait on every iPhone but the Duo. The single column every other phone draws gains
    /// nothing from turning — it is the same column, twice as wide — while the Duo's unfolded
    /// screen has the width for both panes whichever way up it is held, so it keeps its landscape.
    /// iPad is untouched: its split view and the width classes it reports depend on turning.
    ///
    /// Declared here rather than by narrowing the Info.plist, which is one list for every iPhone:
    /// the plist has to keep landscape for the Duo, and this is the only place that can narrow it
    /// back per device.
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return .all }
        // `RootView`, and with it the Duo check, is iOS 16; a phone that old is no Duo.
        guard #available(iOS 16.0, *) else { return .allButUpsideDown }
        return RootView.isIPhoneDuo ? .allButUpsideDown : .portrait
    }

}
