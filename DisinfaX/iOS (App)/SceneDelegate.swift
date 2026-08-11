//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Michaël Pouget on 2026-08-07.
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }

        // Cold launch: the URL arrives in connectionOptions, NOT via openURLContexts. Handling
        // only the latter means the very first hand-off from the popup is silently dropped,
        // which is the common case — the app usually is not already running.
        for context in connectionOptions.urlContexts { TopUpHandoff.handle(context.url) }
    }

    /// Warm re-open: the app is already running and the popup hands off another amount.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { TopUpHandoff.handle(context.url) }
    }

}
