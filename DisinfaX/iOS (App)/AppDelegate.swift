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
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

}
