import Foundation
import CryptoKit

/// The Fact-Check tab's network layer: a native port of what the extension does in
/// `utils/intelligence.ts`.
///
/// There is no shortcut through the extension here. The workers authenticate with a Supabase
/// access token and verify it themselves, so everything the app wants from them it has to ask
/// for over the same HTTP the extension uses — the only thing handed across the App Group is
/// the token itself.
///
/// Two functions below are not ordinary code. `normalizeText` and `canonicalContext` exist to
/// reproduce the extension's cache key exactly, because the backend keys its rows by that hash:
/// a single differing character does not fail loudly, it silently misses the row the extension
/// already wrote and charges the user a second time for work already paid for. They are ports
/// and must be kept in step with their originals. Nothing else in this file is that fragile.
enum FactCheckClient {

    // MARK: - Endpoints

    private static let preclassifyEndpoint = URL(string: "https://preclassify-tweets.michael-pouget01.workers.dev/")!
    private static let classifyEndpoint = URL(string: "https://classify-tweets.michael-pouget01.workers.dev/")!

    /// Supabase's *publishable* (anon) key — the same one the extension ships, and not a secret:
    /// it grants nothing on its own, and every table and RPC is gated by row-level security keyed
    /// on `auth.uid()`. Here that identity comes from the user's own access token, so the app can
    /// read exactly the rows its owner could read from the extension and no others.
    /// Not private: `SupabaseRealtime` opens its own socket and calls the same `subscribe` RPC
    /// against the same project, and a second copy of the URL and key would be a second thing to
    /// keep in step with the extension.
    static let supabaseBase = "https://pofekzkirnysbuqbxmvp.supabase.co"
    static let supabaseAnonKey = "sb_publishable_4ZX8ljVPNImnvcpLl60Q_g_zgOK77Ua"

    /// The locale claims and reasoning are written in, and the key they are cached under.
    ///
    /// bcp47 ("en-US"), not `Locale.identifier`'s underscore spelling, because that is the shape
    /// the extension sends and therefore the shape the backend's rows are keyed by. A mismatch
    /// there would not error — it would quietly miss every cached translation.
    ///
    /// Deliberately the device's language rather than the popup's: the extension lets a user
    /// override its locale, and that override is not visible from here. Someone who has set one
    /// gets their device language in this tab and, for an input the extension has not seen, a
    /// differently-keyed row.
    static var uiLocale: String {
        if #available(macOS 13.0, iOS 16.0, *) {
            return Locale.current.identifier(.bcp47)
        }
        // The same tag by hand. `identifier` spells it "en_US" on every OS; only the
        // `.bcp47` accessor re-spells it with hyphens, and that accessor is 13/16 and up.
        return Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
    }

    // MARK: - Session

    /// The token to authenticate with, or a thrown reason the app cannot proceed.
    ///
    /// The token is refreshed by the popup every time it opens and the workers reject an expired
    /// one anyway, so checking the expiry here only turns a guaranteed 401 into a sentence the
    /// user can act on. The margin covers the seconds between this check and the request landing.
    private static func liveSession() throws -> SharedTopUpStore.Session {
        guard let session = SharedTopUpStore.session else { throw FactCheckError.sessionUnavailable }
        guard session.expiresAt > Date().addingTimeInterval(30) else { throw FactCheckError.sessionUnavailable }
        return session
    }

    /// Whether a request could authenticate at all, asked without sending one.
    ///
    /// The same test `liveSession` makes, exposed because the answer is knowable before a run is
    /// attempted and not only after one has been refused: the token is in the container and its
    /// expiry is readable from here. Deliberately the same expression rather than a copy of its
    /// reasoning — a control left enabled by this has to be one `liveSession` would let through,
    /// or the app is offering a click it already knows will fail.
    static var canAuthenticate: Bool {
        (try? liveSession()) != nil
    }

    /// The same rule as `canAuthenticate`, answered with the token itself, for the callers that
    /// need the value rather than the verdict — the socket joins with it.
    ///
    /// A live one matters more here than anywhere else, because a channel joined with an expired
    /// token is not refused: row-level security filters it, so it goes quiet instead of failing.
    /// Whoever held it would wait out a full window on a connection that cannot deliver anything.
    static var liveToken: String? {
        (try? liveSession())?.accessToken
    }

    // MARK: - Canonicalisation (must match utils/intelligence.ts)

    /// Canonicalize text before hashing: NFKC-fold, strip control characters and invisible
    /// formatting marks, collapse runs of spaces and tabs, trim. Port of the extension's
    /// `normalizeText`.
    static func normalizeText(_ text: String) -> String {
        var compacted: [Unicode.Scalar] = []
        compacted.reserveCapacity(text.unicodeScalars.count)
        var lastWasSpace = false

        for scalar in text.precomposedStringWithCompatibilityMapping.unicodeScalars {
            guard !isStrippedByNormalize(scalar) else { continue }
            let isSpace = scalar == " " || scalar == "\t"
            if isSpace {
                if lastWasSpace { continue }
                lastWasSpace = true
            } else {
                lastWasSpace = false
            }
            compacted.append(scalar)
        }

        var lower = 0
        var upper = compacted.count
        while lower < upper, isTrimmedByJS(compacted[lower]) { lower += 1 }
        while upper > lower, isTrimmedByJS(compacted[upper - 1]) { upper -= 1 }

        var result = ""
        result.unicodeScalars.reserveCapacity(upper - lower)
        for scalar in compacted[lower..<upper] { result.unicodeScalars.append(scalar) }
        return result
    }

    /// The exact set `normalizeText` deletes: C0 controls except tab/LF/CR, DEL, soft hyphen, the
    /// zero-width and bidi-control blocks, and the BOM. Spelled out rather than using
    /// `.controlCharacters`, which would also take the newlines the workers keep.
    private static func isStrippedByNormalize(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x00...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F, 0xAD,
             0x200B...0x200F, 0x2028, 0x2029, 0x202A...0x202E, 0x2060...0x2064, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// Everything JavaScript's `String.prototype.trim` removes. Named explicitly instead of using
    /// `.whitespacesAndNewlines`, which is close but differs on U+0085 and U+200B — and "close" is
    /// a hash mismatch. After NFKC only space, tab, LF and CR are usually still here; the rest are
    /// listed because NFKC is what removed the others, and relying on that is how this drifts.
    private static func isTrimmedByJS(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029,
             0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// Deterministic serialization of the input, joined by a control character `normalizeText`
    /// cannot leave behind, so no field can forge a boundary. Port of the extension's
    /// `canonicalContext` for the un-threaded case, which is the only one this tab produces:
    /// an app fact-check is a single text, never a reply thread or a quote.
    static func canonicalContext(_ input: FactCheckInput) -> String {
        normalizeText(input.username) + "\u{1F}" + normalizeText(input.fullText)
    }

    /// Hex SHA-256 of the canonical context — the cache key shared with the backend.
    static func hash(of input: FactCheckInput) -> String {
        SHA256.hash(data: Data(canonicalContext(input).utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    // MARK: - Preclassification

    /// Claim boundaries for `input`, streamed as the worker settles on them.
    ///
    /// Yields the claim list so far on every event, so the list builds while the model is still
    /// writing; waiting for the stream to end would leave the screen blank for the length of a
    /// model call. Claim objects are pulled out of the worker's JSON as they complete — see
    /// `ClaimStreamParser`.
    static func preclassify(input: FactCheckInput, locale: String) -> AsyncThrowingStream<[FactCheckClaim], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let session = try liveSession()
                    var request = authorizedRequest(preclassifyEndpoint, token: session.accessToken)
                    request.httpBody = try JSONEncoder().encode(PreclassifyRequest(
                        input: input,
                        locale: locale,
                        hash: "\\x" + hash(of: input),
                        displayedLocale: locale
                    ))

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    try await failIfNotOK(response, bytes)

                    // "replace" sends the whole transformed document on every event (a diffusion
                    // model refining a snapshot); "append" sends only the newly-finalised suffix.
                    // Reading one as the other yields either truncation or a growing pile of
                    // duplicates, so the header decides.
                    var parser = ClaimStreamParser(text: input.fullText, isSnapshot: streamMode(of: response) == "replace")

                    for try await line in bytes.lines {
                        guard let event = SSEEvent(line: line), let content = event.content else { continue }
                        continuation.yield(parser.consume(content))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Research

    /// Researches one claim, streaming the model's reasoning as it is written.
    ///
    /// `claim` is normalized before sending because that is how it was STORED: the preclassify
    /// worker normalized the rewritten text before writing its row, and the backend matches a
    /// researched claim back to that row by exact text. Sending the raw slice makes the lookup
    /// miss — "Claim not found", and the same research bought twice.
    ///
    /// `locators` names the claim to the annotate pipeline, which then annotates it silently
    /// inside this same run — the app's only way to have annotations written for it without
    /// paying for a second run (see `ClaimLocators`).
    static func research(
        claim: String,
        locale: String,
        locators: ClaimLocators? = nil
    ) -> AsyncThrowingStream<FactCheckVerdict, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let session = try liveSession()
                    var request = authorizedRequest(classifyEndpoint, token: session.accessToken)
                    request.httpBody = try JSONEncoder().encode(
                        ResearchRequest(
                            mainClaim: normalizeText(claim),
                            locale: locale,
                            id: locators?.claimId,
                            tweet_hash: locators?.tweetHash,
                            tweet_text: locators?.tweetText,
                            text_locale: locators?.textLocale,
                            claim_index: locators?.claimIndex
                        ))

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    try await failIfNotOK(response, bytes)

                    let isSnapshot = streamMode(of: response) == "replace"
                    var document = ""
                    var grounding: [FactCheckSource] = []
                    var streamed = FactCheckVerdict()

                    for try await line in bytes.lines {
                        guard let event = SSEEvent(line: line) else { continue }
                        if !event.grounding.isEmpty { grounding = event.grounding }
                        guard let content = event.content else { continue }
                        document = isSnapshot ? content : document + content

                        let progress = partialVerdict(from: document)
                        if progress.reasoning != streamed.reasoning
                            || progress.confidence != streamed.confidence
                            || progress.veracity != streamed.veracity {
                            streamed = progress
                            continuation.yield(progress)
                        }
                    }

                    continuation.yield(finalVerdict(from: document, fallback: streamed, grounding: grounding))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Annotations (Flow B)

    /// Names a claim to the annotate pipeline: the tweet it sits in, the revision of the text
    /// its offsets index, and its position among that text's claims.
    ///
    /// Research carries these so the worker annotates the claim silently inside the run the user
    /// already paid for (Flow A). Flow B — `annotate` — is the same locators with the claim's own
    /// id, run on their own when the user asks for annotations later.
    struct ClaimLocators {
        /// Hex SHA-256 of this input, the same hash its rows are keyed by.
        let tweetHash: String
        /// The text as displayed, word for word: the worker hashes it to key the annotations it
        /// writes, so a body that differs by one character writes under a revision nothing reads.
        let tweetText: String
        /// The locale of `tweetText`, which its offsets index.
        let textLocale: String
        let claimIndex: Int
        let claimId: String?
    }

    /// Runs the annotation agent on one claim and returns the corrections it wrote.
    ///
    /// Each pair arrives as its own NDJSON line and is passed straight on through `onPartial`,
    /// because the agent writes them one at a time and a card that waited for the last one would
    /// show nothing for the length of the run.
    ///
    /// Nil means the worker declined to annotate this claim — a verdict gone stale, a claim that
    /// was never researched, a text revision it cannot place. That is the "keep the Annotate
    /// button" answer, and it is passed on as one rather than as an empty result: an EMPTY
    /// dictionary is the opposite, a claim that was annotated and needed no corrections, which
    /// the card shows as reviewed and clean.
    static func annotate(
        claimId: String,
        claimIndex: Int,
        locators: ClaimLocators,
        locale: String,
        onPartial: @escaping ([String: String]) -> Void
    ) async throws -> [String: String]? {
        let session = try liveSession()
        var request = authorizedRequest(classifyEndpoint, token: session.accessToken)
        request.httpBody = try JSONEncoder().encode(AnnotateRequest(
            annotations_only: true,
            claim_index: claimIndex,
            locale: locale,
            tweet_hash: locators.tweetHash,
            tweet_text: locators.tweetText,
            text_locale: locators.textLocale,
            id: claimId
        ))

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw FactCheckError.unreadable }
        // The skip rides a header, because a body of nothing is also how a clean review comes
        // back: the two answers differ, and only the header tells them apart.
        if http.value(forHTTPHeaderField: "X-Annotate-Skipped") != nil { return nil }
        try await failIfNotOK(response, bytes)

        var accumulated: [String: String] = [:]
        for try await line in bytes.lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let range = object["range"] as? [Any], range.count == 2,
                  let start = (range[0] as? NSNumber)?.intValue,
                  let end = (range[1] as? NSNumber)?.intValue,
                  let correction = object["correction"] as? String else { continue }
            accumulated["\(start),\(end)"] = correction
            onPartial(accumulated)
        }
        return accumulated
    }

    /// Pulls the numbers and the reasoning-so-far out of a half-written JSON document.
    ///
    /// Not a JSON parse, deliberately: the document is incomplete for most of the stream, and the
    /// only reason to look at it mid-flight is to show progress. Escapes are decoded here so the
    /// reasoning reads as text as it arrives, and a trailing dangling backslash — a `\n` still
    /// being written — is dropped rather than displayed.
    private static func partialVerdict(from document: String) -> FactCheckVerdict {
        FactCheckVerdict(
            confidence: firstNumber(after: "confidence", in: document),
            veracity: firstNumber(after: "veracity", in: document),
            reasoning: decodeEscapes(firstString(after: "reasoning", in: document)),
            sources: []
        )
    }

    /// The authoritative result: once the stream is complete the document is parsed properly,
    /// escapes and all. The regex'd version above stays as the fallback because the model
    /// sometimes wraps its answer in prose or a markdown fence, and a parse of the whole text
    /// then fails while the interesting object is still sitting inside it.
    private static func finalVerdict(from document: String, fallback: FactCheckVerdict, grounding: [FactCheckSource]) -> FactCheckVerdict {
        var verdict = fallback
        // Grounding is the search results the model was shown, and where sources come from when
        // the model does not list any itself. The model's own list wins where it exists — it is
        // the one it chose to cite — and grounding is then added only where it is not already
        // among them.
        verdict.sources = grounding

        guard let data = outermostJSONObject(in: document),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = root["mainResult"] as? [String: Any] else { return verdict }

        if let confidence = (result["confidence"] as? NSNumber)?.doubleValue { verdict.confidence = confidence }
        if let veracity = (result["veracity"] as? NSNumber)?.doubleValue { verdict.veracity = veracity }
        if let reasoning = result["reasoning"] as? String { verdict.reasoning = reasoning }

        let cited = sources(from: result["sources"])
        if !cited.isEmpty {
            let alreadyCited = Set(cited.map(\.identity))
            verdict.sources = cited + grounding.filter { !alreadyCited.contains($0.identity) }
        }
        return verdict
    }

    /// The model's own source list, in either of the two shapes the prompt has produced: a map
    /// of url → title, or the older title → url. Which one comes back is decided by the model,
    /// not by us, so both are accepted and told apart by the shape of the key.
    private static func sources(from raw: Any?) -> [FactCheckSource] {
        guard let map = raw as? [String: Any] else { return [] }
        return map.compactMap { key, value in
            guard let text = value as? String, !text.isEmpty else { return nil }
            return key.hasPrefix("http")
                ? FactCheckSource(title: text, url: key)
                : FactCheckSource(title: key, url: text)
        }
    }

    private static func firstNumber(after field: String, in document: String) -> Double? {
        guard let regex = try? NSRegularExpression(pattern: "\"\(field)\"\\s*:\\s*(-?[0-9.]+)") else { return nil }
        let range = NSRange(document.startIndex..., in: document)
        guard let match = regex.firstMatch(in: document, range: range),
              let captured = Range(match.range(at: 1), in: document) else { return nil }
        return Double(document[captured])
    }

    /// The string after `field`, still JSON-escaped and possibly truncated mid-escape, which is
    /// exactly the state it is in for most of the stream.
    private static func firstString(after field: String, in document: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "\"\(field)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)") else { return "" }
        let range = NSRange(document.startIndex..., in: document)
        guard let match = regex.firstMatch(in: document, range: range),
              let captured = Range(match.range(at: 1), in: document) else { return "" }
        return String(document[captured])
    }

    /// Turns JSON string escapes into the characters they stand for, dropping a sequence that is
    /// still arriving rather than showing half of it.
    private static func decodeEscapes(_ text: String) -> String {
        guard text.contains("\\") else { return text }
        var output = ""
        var index = text.startIndex

        while index < text.endIndex {
            let character = text[index]
            guard character == "\\" else {
                output.append(character)
                index = text.index(after: index)
                continue
            }

            let marker = text.index(after: index)
            guard marker < text.endIndex else { break }   // dangling backslash

            if text[marker] == "u" {
                let hexStart = text.index(after: marker)
                guard let hexEnd = text.index(hexStart, offsetBy: 4, limitedBy: text.endIndex),
                      let value = UInt32(text[hexStart..<hexEnd], radix: 16) else {
                    index = marker
                    continue
                }
                // Above the BMP a character is written as two escapes, and a Swift scalar cannot
                // hold half of a surrogate pair — so the low half is consumed here as well.
                if (0xD800...0xDBFF).contains(value), hexEnd < text.endIndex, text[hexEnd] == "\\" {
                    let lowMarker = text.index(after: hexEnd)
                    if lowMarker < text.endIndex, text[lowMarker] == "u" {
                        let lowStart = text.index(after: lowMarker)
                        if let lowEnd = text.index(lowStart, offsetBy: 4, limitedBy: text.endIndex),
                           let low = UInt32(text[lowStart..<lowEnd], radix: 16), (0xDC00...0xDFFF).contains(low),
                           let combined = Unicode.Scalar(0x10000 + (value - 0xD800) * 0x400 + (low - 0xDC00)) {
                            output.unicodeScalars.append(combined)
                            index = lowEnd
                            continue
                        }
                    }
                }
                if let scalar = Unicode.Scalar(value) { output.unicodeScalars.append(scalar) }
                index = hexEnd
                continue
            }

            switch text[marker] {
            case "n": output.append("\n")
            case "t": output.append("\t")
            case "r": output.append("\r")
            case "b": output.append("\u{08}")
            case "f": output.append("\u{0C}")
            case "/": output.append("/")
            case "\\": output.append("\\")
            case "\"": output.append("\"")
            default: output.append(text[marker])
            }
            index = text.index(after: marker)
        }
        return output
    }

    /// The first complete JSON object in `document`, ignoring anything around it.
    private static func outermostJSONObject(in document: String) -> Data? {
        guard let start = document.firstIndex(of: "{") else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        var cursor = start

        while cursor < document.endIndex {
            let character = document[cursor]
            if inString {
                if escaped { escaped = false }
                else if character == "\\" { escaped = true }
                else if character == "\"" { inString = false }
            } else if character == "\"" {
                inString = true
            } else if character == "{" {
                depth += 1
            } else if character == "}" {
                depth -= 1
                if depth == 0 { return Data(document[start...cursor].utf8) }
            }
            cursor = document.index(after: cursor)
        }
        return nil
    }

    // MARK: - Cached results

    /// One tweet↔claim link as the backend holds it.
    ///
    /// The tab works in rows rather than in finished claims because the same row is used two
    /// ways: a row under this text's own hash IS a claim to show, while a row that turns up for a
    /// claim already on screen is folded INTO that claim, and only the row's own fields decide
    /// what it contributes. Keeping the row whole also keeps its id — the name the annotation
    /// agent is given, since Flow B has no text fallback to resolve the claim by.
    struct ClaimRow {
        /// `claims.id`: the link's claim, and the only name the annotation agent accepts.
        let id: String?
        /// The stored claim text — a different phrasing of this text's claim whenever
        /// preclassification answered by LINKING rather than by researching a row of its own.
        let claim: String?
        let claimLocale: String?
        let reasoningLocale: String?
        /// This text's own range for the claim, revision-gated. For a linked claim the stored
        /// text names nothing here; the highlight is what does.
        let highlight: (start: Int, end: Int)?
        /// `<locale>:<sha256-of-body>` → `"start,end"` → correction, revision-gated to the body
        /// the caller is holding. A key with no ranges is a claim reviewed and found clean; no
        /// key at all is one never annotated.
        let annotations: [String: [String: String]]
        /// Past its reclassification date: a verdict worth showing, and worth re-running.
        let reclassify: Bool
        /// A classification this claim is in the middle of: `claims.is_classifying` set within the
        /// last 25 seconds. The claim is being paid for by someone — this app, the popup, a page —
        /// and its row is unanswered until that run writes, which is the one case where an
        /// unanswered row must NOT be read as "nobody has done this".
        let isClassifying: Bool
        let veracity: Double?
        /// The model's certainty. `veracity` only picks the direction — below 0.2 nothing is
        /// claimed at all — which is why the badge reads this one.
        let probability: Double?
        let reasoning: String?
        let sources: [FactCheckSource]

        /// Whether the row answers its claim: reasoning is what makes a claim answered, and
        /// without it the claim is shown on hold with its Fact-Check button instead.
        var isAnswered: Bool { !(reasoning ?? "").isEmpty }
    }

    /// The rows the backend already holds for this exact input, or none.
    ///
    /// It is also the only route to a claim's id, and so to its annotations: the app has no
    /// Realtime subscription to be told when a detached write lands, and a row read is how the
    /// tab learns what the backend holds. That read is metered — the RPC bills a `fetches` unit
    /// against a rate limit that ends in a ban — so callers read once where they can and re-read
    /// only where the alternative is a charge for work already paid for.
    ///
    /// Worth the extra round trip, and not an optimisation to skip: the preclassify worker has no
    /// cache of its own — it takes a hold and runs the model on every request — so this lookup is
    /// the only thing standing between the user and being charged again for a text that has
    /// already been classified. It reads the row the extension writes for the same hash, so a hit
    /// buys exactly the same answer for nothing.
    ///
    /// Never throws. A lookup that fails is a miss, not an error: the worst case of ignoring it is
    /// the price the user would have paid without it.
    static func cachedRows(for input: FactCheckInput, locale: String) async -> [ClaimRow] {
        guard let session = try? liveSession(),
              let url = URL(string: "\(supabaseBase)/rest/v1/rpc/fetch_tweet_and_touch_network") else { return [] }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["input_hash": "\\x" + hash(of: input)])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return [] }

        // The RPC returns a table, so an array of rows; a bare object shows up in the
        // singular-return variants. Both are read rather than assuming one.
        let decoded = try? JSONSerialization.jsonObject(with: data)
        let rows: [[String: Any]]
        if let array = decoded as? [[String: Any]] {
            rows = array
        } else if let single = decoded as? [String: Any] {
            rows = [single]
        } else {
            return []
        }

        guard let row = rows.first, let linked = row["tweet_claims"] as? [[String: Any]] else { return [] }
        return linked.compactMap { claimRow(from: $0, body: input.fullText, locale: locale) }
    }

    /// One link row, read into the pieces the tab works with. Both range-bearing fields are held
    /// to the revision of the body in hand, so a range measured against a translation, or against
    /// a body the text has since been edited away from, cannot be painted onto the wrong
    /// characters.
    private static func claimRow(from link: [String: Any], body: String, locale: String) -> ClaimRow? {
        guard let raw = link["claims"] as? [String: Any] else { return nil }
        return claimRow(
            fields: raw,
            highlight: link["highlight"],
            annotations: link["annotations"],
            body: body,
            locale: locale
        )
    }

    /// The same row read from a payload that carries everything flat: a Realtime
    /// `subscriptions` payload is the claim row the trigger wrote, where a cache read holds the
    /// claim nested under its link and the tweet-scoped ranges beside it. One reader for both, so
    /// a value folded in over the socket is gated and localized exactly as the same value read
    /// back from the table would be.
    static func claimRow(fromPayload payload: [String: Any], body: String, locale: String) -> ClaimRow {
        claimRow(
            fields: payload,
            highlight: payload["highlight"],
            annotations: payload["annotations"],
            body: body,
            locale: locale
        )
    }

    private static func claimRow(
        fields raw: [String: Any],
        highlight: Any?,
        annotations: Any?,
        body: String,
        locale: String
    ) -> ClaimRow {
        let claim = localizedValue(raw["claim"], locale: locale)
        let reasoning = localizedValue(raw["claims_localized_reasoning"] ?? raw["reasoning"], locale: locale)
        return ClaimRow(
            id: raw["id"] as? String,
            claim: claim?.text,
            claimLocale: claim?.locale,
            reasoningLocale: reasoning?.locale,
            highlight: highlightRange(highlight, body: body, locale: locale),
            annotations: displayAnnotations(annotations, body: body),
            reclassify: (raw["reclassify"] as? Bool) ?? false,
            isClassifying: (raw["is_classifying"] as? Bool) ?? false,
            veracity: (raw["veracity"] as? NSNumber)?.doubleValue,
            probability: (raw["probability"] as? NSNumber)?.doubleValue,
            reasoning: reasoning?.text,
            sources: sources(from: raw["sources"])
        )
    }

    // MARK: - Revision gates and annotations

    /// A `"<locale>:<sha256>"` key split into its parts, or nil for a legacy bare-locale key.
    /// (splitHighlightKey, utils/textBreakup.ts.) The hash is checked to be one so a locale that
    /// happens to contain a colon is not mistaken for a revision.
    private static func splitRevisionKey(_ key: String) -> (prefix: String, hash: String)? {
        guard let colon = key.lastIndex(of: ":"), colon > key.startIndex else { return nil }
        let hash = String(key[key.index(after: colon)...])
        guard hash.count == 64,
              hash.allSatisfy({ $0.isNumber || ("a"..."f").contains($0) }) else { return nil }
        return (String(key[key.startIndex..<colon]), hash)
    }

    /// Keep only the revision of a persisted range dict that binds to a body the caller holds,
    /// re-emitted under its bare locale prefix. (selectHighlightRevision — and its
    /// selectAnnotationRevision alias — utils/textBreakup.ts:451.)
    ///
    /// The server appends a key per revision rather than replacing one, so a single dict carries
    /// ranges measured against bodies the tab is not showing: a translation, or a body the text
    /// has since been edited away from. Those offsets address characters that have moved, and
    /// painting them is worse than painting nothing. Per locale prefix the best tier wins — the
    /// displayed body, then another held body, then a legacy bare key — and anything else is
    /// dropped, which is what routes the claim through a fresh annotate instead of a wrong paint.
    static func selectRevision<T>(_ ranges: [String: T], displayed: String?, known: Set<String>) -> [String: T] {
        var best: [String: (tier: Int, value: T)] = [:]
        for (key, value) in ranges {
            guard let split = splitRevisionKey(key) else {
                if (best[key]?.tier ?? -1) <= 0 { best[key] = (0, value) }
                continue
            }
            let tier = split.hash == displayed ? 2 : (known.contains(split.hash) ? 1 : -1)
            guard tier >= 0 else { continue }
            if (best[split.prefix]?.tier ?? -1) <= tier { best[split.prefix] = (tier, value) }
        }
        return best.mapValues(\.value)
    }

    /// A body's own revision hash: the `<hash>` half of a `<locale>:<hash>` key, and the hash the
    /// annotate worker computes over the text it is handed. Raw UTF-8 in, lowercase hex out,
    /// byte-identical to the workers' own `sha256Hex` — which is the whole point, since a
    /// revision key that disagrees by one character silently means "never annotated".
    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The gate for a body: the body itself, plus its trimmed form — the two strings a worker
    /// might have hashed, since what this tab sends is the text as the user wrote it.
    private static func revisionGate(for body: String) -> (displayed: String?, known: Set<String>) {
        guard !body.isEmpty else { return (nil, []) }
        var known: Set<String> = [sha256Hex(body)]
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { known.insert(sha256Hex(trimmed)) }
        return (sha256Hex(body), known)
    }

    /// A link's annotations, held to the body in hand. Empty when nothing survives — and that
    /// emptiness is the signal, so a key kept with no ranges (reviewed, nothing to correct) stays
    /// distinguishable from a claim never annotated at all.
    private static func displayAnnotations(_ value: Any?, body: String) -> [String: [String: String]] {
        guard let dict = value as? [String: Any] else { return [:] }
        var raw: [String: [String: String]] = [:]
        for (key, entry) in dict {
            guard let ranges = entry as? [String: Any] else { continue }
            var kept: [String: String] = [:]
            for (range, correction) in ranges {
                if let correction = correction as? String { kept[range] = correction }
            }
            raw[key] = kept
        }
        guard !raw.isEmpty else { return [:] }
        let gate = revisionGate(for: body)
        return selectRevision(raw, displayed: gate.displayed, known: gate.known)
    }

    /// The span of `body` a link's highlight addresses for this locale, or nil when there is no
    /// highlight bound to this revision of the text.
    private static func highlightRange(_ value: Any?, body: String, locale: String) -> (start: Int, end: Int)? {
        guard let dict = value as? [String: Any], !body.isEmpty else { return nil }
        var ranges: [String: (start: Int, end: Int)] = [:]
        for (key, entry) in dict {
            guard let pair = entry as? [Any], pair.count == 2,
                  let start = (pair[0] as? NSNumber)?.intValue,
                  let end = (pair[1] as? NSNumber)?.intValue else { continue }
            ranges[key] = (start, end)
        }
        let gate = revisionGate(for: body)
        let kept = selectRevision(ranges, displayed: gate.displayed, known: gate.known)
        guard let range = resolveRange(kept, locale: locale) else { return nil }
        // JavaScript indices, so the bound is counted the same way: UTF-16 code units.
        let limit = body.utf16.count
        guard range.start >= 0, range.start < range.end, range.end <= limit else { return nil }
        return range
    }

    /// A locale's entry out of a stripped range dict: the exact locale first, then the same base
    /// language. (resolveHighlightRange, utils/textBreakup.ts.)
    private static func resolveRange(
        _ ranges: [String: (start: Int, end: Int)],
        locale: String
    ) -> (start: Int, end: Int)? {
        if let exact = ranges[locale] { return exact }
        let base = locale.split(separator: "-").first.map(String.init) ?? locale
        for (key, value) in ranges where key == base || key.hasPrefix(base + "-") { return value }
        return nil
    }

    /// A field that may be a plain string or a locale-keyed dictionary, with the locale it
    /// actually came from — which is what tells the tab a claim is in a language it is not being
    /// read in, and so that Translate has something to do.
    private static func localizedValue(_ value: Any?, locale: String) -> (text: String, locale: String)? {
        if let text = value as? String { return (text, locale) }
        guard let map = value as? [String: Any] else { return nil }
        if let exact = map[locale] as? String { return (exact, locale) }
        // The same language is worth more than an unrelated one: "fr" is a better answer for a
        // "fr-CA" run than whichever locale happens to be first in the dictionary.
        let base = locale.split(separator: "-").first.map(String.init) ?? locale
        if let match = map.first(where: { $0.key == base || $0.key.hasPrefix(base + "-") }),
           let text = match.value as? String { return (text, match.key) }
        if let first = map.first(where: { $0.value is String }), let text = first.value as? String {
            return (text, first.key)
        }
        return nil
    }

    // MARK: - Locating a claim's text

    /// The span a UTF-16 range addresses, or nil when the range does not sit inside `body`.
    ///
    /// A range that splits a surrogate pair yields a replacement character rather than trapping:
    /// the offsets come from JavaScript, where every index is a code unit, so a boundary that
    /// cannot be expressed as Swift characters is possible in principle and must not be fatal.
    static func slice(_ body: String, _ range: (start: Int, end: Int)) -> String? {
        let units = Array(body.utf16)
        guard range.start >= 0, range.end > range.start, range.end <= units.count else { return nil }
        return String(decoding: units[range.start..<range.end], as: UTF16.self)
    }

    /// Whether these annotations paint anything on a claim's own text.
    ///
    /// A claim whose dict holds a locale key but no ranges was reviewed and found clean, which is
    /// a different thing from one that was never annotated — and the difference is what the card
    /// says in words, since neither paints a range.
    static func hasAnnotationRanges(
        _ annotations: [String: [String: String]],
        textLength: Int,
        segStart: Int
    ) -> Bool {
        !annotationRanges(annotations, textLength: textLength, segStart: segStart).isEmpty
    }

    /// The ranges an annotation dict paints on a claim's text, as offsets into that text.
    ///
    /// Port of `extractRanges` (entrypoints/popup/AnnotatedText.tsx). The stored keys are absolute
    /// offsets into the whole input, so the claim's own start comes off them; a range that falls
    /// entirely outside the claim is dropped and one that only overlaps it is clamped, and the
    /// result is sorted because the painter walks it in order.
    static func annotationRanges(
        _ annotations: [String: [String: String]],
        textLength: Int,
        segStart: Int
    ) -> [(start: Int, end: Int, correction: String)] {
        var valid: [(start: Int, end: Int, correction: String)] = []
        for (_, ranges) in annotations {
            for (key, correction) in ranges {
                let parts = key.split(separator: ",")
                guard parts.count == 2,
                      let absoluteStart = Int(parts[0]), let absoluteEnd = Int(parts[1]),
                      absoluteEnd >= absoluteStart else { continue }

                let start = absoluteStart - segStart
                let end = absoluteEnd - segStart
                // A zero-width range is an insertion point — the claim-leading insertion the agent
                // emits under an empty-string key. No strike is drawn for it, and it has no width
                // that could fall outside the claim, so only its own bounds can disqualify it.
                // Every other non-positive end belongs to text before this claim.
                let insideClaim = start == end
                    ? (start >= 0 && end <= textLength)
                    : (end > 0 && start < textLength)
                guard insideClaim else { continue }
                valid.append((max(0, start), min(textLength, end), correction))
            }
        }
        // By end as well as start: two ranges sharing a start are ordered by width, so an
        // insertion point sorts ahead of a strike opening on the same character — the same
        // tiebreak the page's `annotationRanges` and the popup's `extractRanges` use.
        return valid.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
    }

    /// Whether a row describes this claim.
    ///
    /// By id once the claim has one. Before that by text, because a claim the preclassifier has
    /// just created has no id until the worker's detached pipeline writes its row — and the two
    /// candidates are the row's own stored text (the claim as the worker normalized it) and the
    /// span this text's highlight covers (the claim as this input phrased it). Either can be the
    /// one that matches; both are normalized, since normalizing is what the worker did between
    /// the phrasing the tab holds and the text it stored.
    /// (claimRowIs / claimNameCandidates, entrypoints/popup/FactCheckTab.tsx.)
    static func row(_ row: ClaimRow, describes claim: FactCheckClaim, body: String) -> Bool {
        if let id = claim.claimId, let rowId = row.id, id == rowId { return true }

        var names: [String] = []
        if let stored = row.claim, !stored.isEmpty { names.append(normalizeText(stored)) }
        if let highlight = row.highlight, let spanned = slice(body, highlight), !spanned.isEmpty {
            names.append(normalizeText(spanned))
        }
        guard !names.isEmpty else { return false }

        let wanted = [normalizeText(claim.rewritten), normalizeText(claim.rawText)]
        return names.contains { wanted.contains($0) }
    }

    /// The claim a row describes, straight from the row: the fields a row owns rather than the
    /// ones a research stream owns. Used both by the first read of a text and by the row read an
    /// Annotate tap falls back on when the claim has no id yet.
    static func claim(from row: ClaimRow, body: String, locale: String) -> FactCheckClaim {
        // The stored text names the claim; the highlight is this text's own words for it, and is
        // what there is to show when the stored text is a rephrasing (a linked claim keeps the
        // wording of whichever text first researched it).
        let spanned = row.highlight.flatMap { slice(body, $0) }
        let raw = spanned ?? row.claim ?? body
        let rewritten = row.claim ?? raw

        let answered = row.isAnswered
        return FactCheckClaim(
            rawText: raw,
            rewritten: rewritten,
            range: row.highlight,
            claimId: row.id,
            annotations: row.annotations,
            claimLocale: row.claimLocale,
            isClassified: answered && !row.reclassify,
            needsReclassify: answered && row.reclassify,
            // A row that is past its reclassification date still holds a real answer, and it is
            // the one a re-run shows while it runs (the card gates the badge on the run, exactly
            // as the popup does with cachedResult).
            verdict: answered ? FactCheckVerdict(
                confidence: row.probability ?? abs(row.veracity ?? 0),
                veracity: row.veracity,
                reasoning: row.reasoning ?? "",
                sources: row.sources
            ) : nil
        )
    }

    // MARK: - Transport

    private static func authorizedRequest(_ url: URL, token: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func streamMode(of response: URLResponse) -> String {
        (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Stream-Mode") ?? "append"
    }

    /// Fails with the worker's own failure when the status is not a success.
    ///
    /// The body is only read on failure, where it is short — draining a succeeded stream to look
    /// for an error that is not there would throw the answer away.
    private static func failIfNotOK(_ response: URLResponse, _ bytes: URLSession.AsyncBytes) async throws {
        guard let http = response as? HTTPURLResponse else { throw FactCheckError.unreadable }
        guard !(200..<300).contains(http.statusCode) else { return }

        var body = Data()
        for try await byte in bytes { body.append(byte) }
        throw FactCheckError.worker(status: http.statusCode, body: body)
    }
}

// MARK: - Input

/// The tweet-shaped envelope the preclassify worker validates its input against.
///
/// The app has no tweet, so the user's own text stands in as one, attributed to their account.
/// Shape matters as much as content: the worker rejects a request missing any of these fields
/// with a 400 before it charges anything, and it re-derives the hash from `username` and
/// `fullText` to check the one it was sent.
struct FactCheckInput: Encodable {
    let id: String
    let text: String
    let fullText: String
    let username: String
    let usertype: String
    let time: String

    /// `id` and `time` reach neither the hash nor the model — the worker's canonical context is
    /// built from the username and the text alone — but they are part of the shape it expects.
    init(text: String, username: String) {
        self.id = "app_\(Int(Date().timeIntervalSince1970 * 1000))"
        self.text = text
        self.fullText = text
        self.username = username
        self.usertype = "None"
        self.time = ISO8601DateFormatter().string(from: Date())
    }
}

// MARK: - Results

/// A claim as the workers report it, plus whatever the user's fact-check of it has produced.
struct FactCheckClaim: Identifiable {
    let id = UUID()
    /// The verbatim slice of the input text, when the worker could locate it.
    let rawText: String
    /// The worker's self-contained rewrite — what gets researched and what is shown as the claim.
    let rewritten: String
    /// UTF-16 offsets into the input text, the units the worker's ranges are expressed in.
    let range: (start: Int, end: Int)?

    /// `claims.id` once a row read has named it — the only name the annotation agent accepts for
    /// a claim, and what identifies the claim to every read after the first.
    var claimId: String?
    /// `<text-locale>:<sha256-of-the-body-the-ranges-address>` → `"start,end"` → correction,
    /// narrowed to the revision of the body in hand. A locale key with no ranges is a claim that
    /// was reviewed and found clean; no key at all is one never annotated.
    var annotations: [String: [String: String]] = [:]
    /// The language the stored claim text came back in, which is what tells the card that the
    /// text it is showing is not the text it was written as.
    var claimLocale: String?
    /// A current, settled answer is on screen — the gate the badge and the Annotate button share.
    var isClassified = false
    /// The row is past its reclassification date: worth showing, and worth running again.
    var needsReclassify = false
    /// Research for this claim ran with locators, so Flow A is annotating it server-side and an
    /// Annotate button now would buy a run already on its way. Cleared after the window the
    /// on-page flow allows for that write, so a write that never lands does not withhold it
    /// forever.
    var awaitingAnnotations = false
    var isAnnotating = false

    /// Nil while the claim is preclassified but not yet researched, which is the state the
    /// Fact-Check button exists for.
    var verdict: FactCheckVerdict?
    var isResearching = false
    var errorMessage: String?

    /// Never annotated, as opposed to annotated and found clean: the clean review keeps its
    /// locale key with no ranges under it, so an empty dict is the only "nothing known" state.
    var missingAnnotations: Bool { annotations.isEmpty }
}

struct FactCheckVerdict {
    /// Nil rather than 0 before the model has committed to a figure: 0 is a real answer meaning
    /// "unknown", and showing it as progress would flash a verdict the model has not reached.
    var confidence: Double?
    var veracity: Double?
    var reasoning: String = ""
    var sources: [FactCheckSource] = []
}

struct FactCheckSource: Identifiable {
    let id = UUID()
    let title: String?
    let url: String?

    /// What makes two sources the same source, for de-duplication across the model's own list and
    /// the provider's grounding metadata — which routinely describe the same page.
    var identity: String { url ?? title ?? "" }
}

// MARK: - Wire shapes

private struct PreclassifyRequest: Encodable {
    let input: FactCheckInput
    /// The UI locale the rewritten claims are written in.
    let locale: String
    /// The bytea literal (`\x…`) of the tweet hash — the form the worker compares against.
    let hash: String
    /// The locale of `input.text`, which the highlight ranges index. The same as `locale` here:
    /// the text being checked is the user's own, so it is already in their language.
    let displayedLocale: String
}

private struct ResearchRequest: Encodable {
    let mainClaim: String
    let locale: String
    /// Flow A's locators, absent unless the claim being researched has a position in a text the
    /// annotate worker can re-derive. Sending all of them makes the worker annotate this claim
    /// silently once the research save has landed; sending none is the old request, and the run
    /// simply comes back unannotated.
    let id: String?
    let tweet_hash: String?
    let tweet_text: String?
    let text_locale: String?
    let claim_index: Int?
}

/// Flow B: the same locators with the claim's id, and no research at all.
private struct AnnotateRequest: Encodable {
    let annotations_only: Bool
    let claim_index: Int
    let locale: String
    let tweet_hash: String
    let tweet_text: String
    let text_locale: String
    let id: String
}

/// One `data:` line of a worker's SSE stream, decoded.
///
/// Content and grounding are read separately because they arrive differently: the text is
/// streamed token by token, while grounding metadata rides on whichever event the provider
/// chooses — usually the last — and is the only place source URLs appear when the model does not
/// list them in its own answer.
private struct SSEEvent {
    let content: String?
    let grounding: [FactCheckSource]

    init?(line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data: ") else { return nil }
        let payload = String(trimmed.dropFirst(6))
        guard payload != "[DONE]",
              let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        // Two providers, two shapes: Gemini nests the text under candidates[0].content.parts[0],
        // the OpenAI-compatible ones under choices[0].delta.content. Both are in use upstream, so
        // both are read rather than assuming whichever one this build happened to see.
        let candidate = (object["candidates"] as? [[String: Any]])?.first
        let parts = (candidate?["content"] as? [String: Any])?["parts"] as? [[String: Any]]
        let gemini = parts?.first?["text"] as? String
        let choices = object["choices"] as? [[String: Any]]
        let openai = (choices?.first?["delta"] as? [String: Any])?["content"] as? String

        self.content = gemini ?? openai
        self.grounding = Self.groundingSources(from: candidate)
    }

    private static func groundingSources(from candidate: [String: Any]?) -> [FactCheckSource] {
        guard let chunks = (candidate?["groundingMetadata"] as? [String: Any])?["groundingChunks"] as? [[String: Any]] else { return [] }
        return chunks.compactMap { chunk in
            guard let web = chunk["web"] as? [String: Any] else { return nil }
            let title = web["title"] as? String
            let url = web["uri"] as? String
            guard title != nil || url != nil else { return nil }
            return FactCheckSource(title: title, url: url)
        }
    }
}

/// Pulls whole claim objects out of the worker's JSON as they finalise.
///
/// The worker emits a JSON array and appends it one element at a time, so at any moment the buffer
/// holds some complete objects followed by a partial one. Objects are removed as they are parsed,
/// which is what keeps the scan cheap and stops a partial object from being parsed twice. Replace
/// mode is the same text as a whole document on every event instead of as an increment, so there
/// the buffer is the answer rather than a growing tail.
private struct ClaimStreamParser {
    private let text: String
    private let isSnapshot: Bool
    private var buffer = ""
    private var claims: [FactCheckClaim] = []

    init(text: String, isSnapshot: Bool) {
        self.text = text
        self.isSnapshot = isSnapshot
    }

    mutating func consume(_ chunk: String) -> [FactCheckClaim] {
        buffer = isSnapshot ? chunk : buffer + chunk
        if isSnapshot { claims = [] }
        drain()
        return claims
    }

    private mutating func drain() {
        var consumed = buffer.startIndex
        var searchFrom = buffer.startIndex

        while let start = buffer[searchFrom...].firstIndex(of: "{") {
            // No closing brace yet: this object is still arriving, and so is everything after it.
            guard let end = endOfObject(from: start) else { break }
            if let object = try? JSONSerialization.jsonObject(with: Data(buffer[start..<end].utf8)) as? [String: Any],
               let claim = claim(from: object) {
                claims.append(claim)
            }
            consumed = end
            searchFrom = end
        }

        if consumed > buffer.startIndex { buffer.removeSubrange(buffer.startIndex..<consumed) }
    }

    /// The index just past the `}` matching the `{` at `start`, or nil while that object is still
    /// arriving. Braces inside strings do not count — a claim containing `{` is ordinary text, and
    /// treating it as a delimiter would derail the scan and silently lose every claim after it.
    private func endOfObject(from start: String.Index) -> String.Index? {
        var depth = 0
        var inString = false
        var escaped = false
        var cursor = start

        while cursor < buffer.endIndex {
            let character = buffer[cursor]
            if inString {
                if escaped { escaped = false }
                else if character == "\\" { escaped = true }
                else if character == "\"" { inString = false }
            } else if character == "\"" {
                inString = true
            } else if character == "{" {
                depth += 1
            } else if character == "}" {
                depth -= 1
                if depth == 0 { return buffer.index(after: cursor) }
            }
            cursor = buffer.index(after: cursor)
        }
        return nil
    }

    /// One `{ text: [start, end], rewritten }` record from the worker.
    private func claim(from object: [String: Any]) -> FactCheckClaim? {
        let rewritten = (object["rewritten"] as? String) ?? ""

        // The offsets are JavaScript string indices — UTF-16 code units — validated by the worker
        // against the same text it was sent. Slicing by Character or by UTF-8 byte would land
        // somewhere else entirely on any input containing an emoji.
        let units = Array(text.utf16)
        if let bounds = object["text"] as? [Any], bounds.count == 2,
           let start = (bounds[0] as? NSNumber)?.intValue,
           let end = (bounds[1] as? NSNumber)?.intValue,
           start >= 0, end > start, end <= units.count {
            let slice = String(decoding: units[start..<end], as: UTF16.self)
            return FactCheckClaim(rawText: slice, rewritten: rewritten.isEmpty ? slice : rewritten, range: (start, end))
        }

        // [-1,-1] is the worker saying it could not locate its own rewrite in the text. The
        // rewrite is still the claim and still worth showing, just without a position.
        guard !rewritten.isEmpty else { return nil }
        return FactCheckClaim(rawText: rewritten, rewritten: rewritten, range: nil)
    }
}

// MARK: - Errors

enum FactCheckError: LocalizedError {
    case sessionUnavailable
    case worker(status: Int, body: Data)
    case unreadable

    var errorDescription: String? {
        switch self {
        case .sessionUnavailable:
            return String(localized: "Your session needs refreshing — open the DisinfaX popup in Safari, then try again.")
        case .worker(let status, let body):
            return Self.message(forStatus: status, body: body)
        case .unreadable:
            return String(localized: "Something went wrong on our end. Please try again in a moment.")
        }
    }

    /// A worker's failure, in the user's language.
    ///
    /// Every worker prefixes its error text with a numeric code — `"1 - Your balance is too
    /// low…"` — and the code, not the sentence after it, is the stable contract. The extension
    /// keeps its own translated copy of each; so does this, so a recognized failure is shown in
    /// the user's language rather than in the backend's English. An unrecognized code falls back
    /// to whatever sentence came with it, which is what a backend newer than this build sends.
    private static func message(forStatus status: Int, body: Data) -> String {
        let raw = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? String

        if let raw, let separator = raw.range(of: " - "),
           let code = Int(raw[raw.startIndex..<separator.lowerBound]) {
            return localizedMessage(forCode: code)
                ?? fallbackText(String(raw[separator.upperBound...]), locale: FactCheckClient.uiLocale)
        }

        // 401 and 402 mean something even when there is no body to read it from.
        if status == 401 { return String(localized: "You're not signed in. Please sign in and try again.") }
        if status == 402 { return String(localized: "Your balance is too low. Please top up to continue.") }
        if let raw, !raw.isEmpty { return raw }
        return String(localized: "Something went wrong on our end. Please try again in a moment.")
    }

    /// The sentence after the dash, for a code this build does not recognize — the shape a backend
    /// newer than this app sends.
    ///
    /// A `{…}` body there is a dictionary of locale → sentence, and the whole point of sending one
    /// is that the reader picks its own: the backend localizes the text for codes whose wording it
    /// owns, and can only offer it this way for one it has just invented. Anything else is shown as
    /// it came. Mirrors `resolveUnrecognizedCodeText` in the extension's `utils/errorCodes.ts`,
    /// including its order of preference — exact locale, then the same base language, then English —
    /// because a code means the same thing on both surfaces.
    private static func fallbackText(_ rest: String, locale: String) -> String {
        let trimmed = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), trimmed.hasSuffix("}"),
              let data = trimmed.data(using: .utf8),
              let dictionary = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { return rest }

        // Sorted rather than in the order the body listed them: JSONSerialization hands back an
        // unordered dictionary, and a regional variant picked at random — `pt-PT` on one launch,
        // `pt-BR` on the next — would be the same sentence changing between runs.
        let entries = dictionary.sorted { $0.key < $1.key }
        if let exact = dictionary[locale] { return exact }
        if let same = entries.first(where: { sameLanguage($0.key, locale) })?.value { return same }
        if let english = entries.first(where: { sameLanguage($0.key, "en") })?.value { return english }
        return entries.first?.value ?? rest
    }

    /// True when two locale tags share their primary language subtag: `en-US` and `en-GB` do,
    /// `en` and `fr` do not. The extension's `sameLanguage`, in `data/Classification.ts`.
    private static func sameLanguage(_ a: String, _ b: String) -> Bool {
        guard !a.isEmpty, !b.isEmpty else { return false }
        return a.prefix(while: { $0 != "-" }).lowercased() == b.prefix(while: { $0 != "-" }).lowercased()
    }

    /// The codes `utils/errorCodes.ts` recognizes, as the same numeric contract, carrying the same
    /// sentences the extension's message files carry — so a code means the same thing on both
    /// surfaces rather than only being consistent within one.
    private static func localizedMessage(forCode code: Int) -> String? {
        switch code {
        case 1: return String(localized: "Your balance is too low. Please top up to continue.")
        case 2: return String(localized: "Your account has been suspended.")
        case 3: return String(localized: "You're not signed in. Please sign in and try again.")
        case 4: return String(localized: "Something about this request wasn't recognized. Please make sure the extension is up to date.")
        case 5: return String(localized: "Something went wrong on our end. Please try again in a moment.")
        case 6: return String(localized: "DisinfaX is not yet available in your region due to regulatory requirements.")
        case 7: return String(localized: "That top-up amount isn't valid. Please choose a different amount.")
        case 8: return String(localized: "That couldn't be found. Please try again.")
        default: return nil
        }
    }
}
