import Foundation

/// The advisories the popup draws above its tabs, fetched by the app itself.
///
/// The popup reads them from the extension's own storage (`mf_messages` in
/// `browser.storage.local`), which is not the App Group the two processes share and is therefore
/// not visible here. So the endpoint the extension's alarm asks is asked from this side too, on
/// the same daily rhythm, and the answer is kept in the group container so a launch draws
/// immediately and the network is only ever correcting a copy that is already on screen.
///
/// Messages are entries of either shape the endpoint serves: a bare string, or a dictionary of
/// language tags to strings. The selection between them is the popup's own (`pickMessages` in
/// Dashboard.tsx) — the exact locale, then any variant of the same language, then English, then
/// whatever string the entry carries — so one message written once reaches both surfaces in the
/// reader's language.
enum ServiceMessages {

    /// The extension's endpoint, unchanged: a message written for one surface is written for both.
    static let source = URL(string: "https://messages.michael-pouget01.workers.dev/")!

    /// The extension's cadence (see `MESSAGES_ALARM` in background.ts). An advisory is not worth
    /// asking about more often than this, and asking on every launch would be asking on every
    /// hour for a window left open.
    static let refreshInterval: TimeInterval = 24 * 60 * 60

    private static let cacheKey = "messages.raw"
    private static let stampKey = "messages.fetchedAt"

    /// The group container, resolved the way the rest of the app resolves it. Nil when the
    /// entitlement is missing, which costs a user their cached copy and nothing else.
    private static var defaults: UserDefaults? {
        SharedTopUpStore.isAvailable ? UserDefaults(suiteName: SharedTopUpStore.appGroupIdentifier) : nil
    }

    /// What was last received, in the reader's language — empty when nothing ever has been.
    /// Drawn before any request goes out, so the block never flickers in after a launch.
    static func cached() -> [String] {
        guard let defaults, let data = defaults.data(forKey: cacheKey),
              let entries = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return [] }
        return pick(entries)
    }

    /// Fetches when the cached copy has aged out, and answers with what should be on screen; nil
    /// when there is nothing newer to draw — either because the copy is still fresh or because
    /// the endpoint could not be reached. A failure deliberately leaves the stamp alone, so the
    /// next check tries again rather than sitting on a stale copy for a day.
    static func refreshIfStale() async -> [String]? { await refresh(maxAge: refreshInterval) }

    /// The popup asks once every time the browser starts, whatever its cache holds — that is how
    /// a message published after the last fetch reaches a reader who never leaves the surface up
    /// for a day — and an app launch is the same moment, so it asks then too.
    static func refreshOnLaunch() async -> [String]? { await refresh(maxAge: 0) }

    private static func refresh(maxAge: TimeInterval) async -> [String]? {
        guard let defaults else { return nil }
        let stamp = defaults.double(forKey: stampKey)
        if maxAge > 0, stamp > 0, Date().timeIntervalSince1970 - stamp < maxAge { return nil }

        var request = URLRequest(url: source)
        // A day-old copy is better than a launch that waits on a dead endpoint.
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let entries = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return nil }

        defaults.set(try? JSONSerialization.data(withJSONObject: entries), forKey: cacheKey)
        defaults.set(Date().timeIntervalSince1970, forKey: stampKey)
        return pick(entries)
    }

    /// The popup's selection rule, over the shapes the endpoint serves.
    private static func pick(_ entries: [Any]) -> [String] {
        let locale = FactCheckClient.uiLocale.lowercased()
        let base = locale.split(separator: "-").first.map(String.init) ?? locale
        var picked: [String] = []
        for entry in entries {
            if let text = entry as? String {
                picked.append(text.trimmingCharacters(in: .whitespacesAndNewlines))
                continue
            }
            guard let dictionary = entry as? [String: Any] else { continue }
            let text = dictionary[locale] as? String
                ?? dictionary.first { key, value in
                    let key = key.lowercased()
                    return (key == base || key.hasPrefix(base + "-")) && value is String
                }?.value as? String
                ?? dictionary["en"] as? String
                ?? dictionary.values.compactMap { $0 as? String }.first
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                picked.append(text)
            }
        }
        return picked.filter { !$0.isEmpty }
    }

    /// One message as drawn: the inline markdown the popup supports (`[text](url)`, `**bold**`,
    /// `*italic*`, `` `code` ``), with a plainly written URL made tappable as well — SwiftUI's
    /// markdown parser links the one form and not the other, and the popup links both.
    ///
    /// The text arrives from a remote endpoint, so a target is trusted no further than the popup
    /// trusts one: anything but http, https or mailto is stripped back to plain text rather than
    /// left for the system to open.
    static func attributed(_ text: String) -> AttributedString {
        var string = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)

        let plain = String(string.characters)
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let whole = NSRange(plain.startIndex..<plain.endIndex, in: plain)
            for match in detector.matches(in: plain, options: [], range: whole) {
                guard let url = match.url,
                      let found = Range(match.range, in: plain),
                      let start = AttributedString.Index(found.lowerBound, within: string),
                      let end = AttributedString.Index(found.upperBound, within: string)
                else { continue }
                // A URL inside a markdown link is already linked; the detector is only for the
                // ones written as themselves.
                if string[start..<end].runs.contains(where: { $0.link != nil }) { continue }
                string[start..<end].link = url
            }
        }

        // Collected first, then cleared: mutating the runs being iterated is a change to the
        // string underneath them.
        let refused = string.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link, !isAllowed(link) else { return nil }
            return run.range
        }
        for range in refused { string[range].link = nil }
        return string
    }

    private static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https" || scheme == "mailto"
    }
}
