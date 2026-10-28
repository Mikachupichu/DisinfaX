import Foundation
import AppIntents

// MARK: - The Shortcuts action
//
// Preclassifies a text and fact-checks every claim it found, returning the whole result as one
// JSON document. Everything goes through `FactCheckClient`, which is the same network layer the
// Fact-Check tab uses: the workers authenticate with the Supabase token the popup hands across the
// App Group, so a run needs a live session and says so when it has none.
//
// App Intents are iOS 16 / macOS 13, and the app targets are iOS 15 / macOS 12, so everything here
// is gated. Nothing outside this file is.
//
// The strings are English literals on purpose. An action's own vocabulary is Shortcuts' — its
// titles, its descriptions and the sentences it invents for a malformed input — and translating
// one of them without the rest would be a half-translated panel. The two sentences it reuses
// rather than writes (`String(localized:)` below) go through the catalogue and are already
// translated, because those are the app's own words for the same two states.

@available(iOS 16.0, macOS 13.0, *)
struct FactCheckTextIntent: AppIntent {

    static var title: LocalizedStringResource = "Fact-Check"

    /// The single-argument form on purpose: the ones that also name a category and a result are
    /// macOS 14 / iOS 17, and this app is built for macOS 12 / iOS 15.
    ///
    /// The description names what goes in and what comes back, because Shortcuts shows it where a
    /// user decides whether this action does what they want — the parameter descriptions below are
    /// only visible once the action is already on the canvas.
    static var description = IntentDescription(
        """
        Finds the verifiable claims in a text and fact-checks every one of them, returning the result as JSON.

        INPUT — the Text can be the text itself, or a JSON object carrying "text" plus any of:
        "context-before" and "context-after" (the passage around it, used only to resolve what a bare claim refers to and never fact-checked itself), "no-fact-checking" (true returns the claims alone, without researching them), and the post fields "username", "usertype" (Business, Government, Verified or None), "datetime" (when the post was written, or last edited, as an ISO 8601 instant in UTC — its claims are then judged as of that date rather than as of today), "quoting" and "replyingTo" (each a nested object of the same shape, for a post and its ancestry).

        OUTPUT — a JSON object keyed on each rewritten claim's text, whose value is an array with one entry per claim holding its "raw-text" and "is_hidden" (whether the post's link flags the claim, keeping it out of sight until a selection uncovers that part of the post); unless "no-fact-checking" was true, each entry also carries "confidence-percentage" and "veracity-percentage" (whole numbers, and veracity keeps its sign: positive is true, negative is false), "reasoning", "sources" (a URL → title dictionary) and "annotations" (the same structure the fact-check shows inline). Failures are reported in an "error-messages" array — at the top level for a failure that stopped the run, and on an individual claim's entry for a failure that stopped that claim.

        A run needs DisinfaX to be signed in on this device.
        """
    )

    @Parameter(
        title: "Text",
        description: "The text to analyse — or a JSON object carrying \"text\", \"context-before\", \"context-after\", \"no-fact-checking\", and optionally the post fields \"username\", \"usertype\", \"quoting\" and \"replyingTo\"."
    )
    var text: String

    @Parameter(
        title: "Context Before",
        description: "The passage before the text, used only to resolve what a bare claim refers to. Never fact-checked itself."
    )
    var contextBefore: String?

    @Parameter(
        title: "Context After",
        description: "The passage after the text, used only to resolve what a bare claim refers to. Never fact-checked itself."
    )
    var contextAfter: String?

    @Parameter(
        title: "No Fact-Checking",
        description: "Return the claims alone, without researching any of them."
    )
    var noFactChecking: Bool?

    /// Text rather than a `Date`, because the field has to be able to carry what the post states
    /// and what a Shortcuts run can actually hand over: a year alone ("2020"), a month, or a full
    /// date. A `Date` parameter cannot — Shortcuts coerces the field to an instant and silently
    /// drops anything that will not convert, and "2020" will not, so the run went out undated and
    /// its claims were judged as of today (measured 2026-10-26: the worker logged
    /// `datetime=null` for an action whose Date field read "2020").
    ///
    /// Passed through as written and read by the worker's own date parser, which already carries
    /// the component forms — year, year-month, date, and the ISO instant the extension sends —
    /// and states only as much of the date as the value actually gives.
    ///
    /// Optional, and absent (or blank) means today: a run that was not told when the post is
    /// written is judged as of now, which is what every run did before this field existed.
    @Parameter(
        title: "Date",
        description: "When the post was written, or last edited: a year (2020), a month (2020-04), or a date (2020-04-07). Its claims are judged as of this date rather than as of today."
    )
    var datetime: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Fact-check \(\.$text)") {
            \.$contextBefore
            \.$contextAfter
            \.$datetime
            \.$noFactChecking
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let trimmed = datetime?.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await FactCheckTextRunner.run(
            rawText: text,
            contextBefore: contextBefore,
            contextAfter: contextAfter,
            noFactChecking: noFactChecking,
            datetime: (trimmed?.isEmpty ?? true) ? nil : trimmed
        )
        return .result(value: result)
    }
}

@available(iOS 16.0, macOS 13.0, *)
struct DisinfaXShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: FactCheckTextIntent(),
            phrases: [
                "Fact-check a text in \(.applicationName)",
                "Fact-check claims with \(.applicationName)"
            ],
            shortTitle: "Fact-Check",
            systemImageName: "checkmark.seal"
        )
    }
}

// MARK: - The run

@available(iOS 16.0, macOS 13.0, *)
private enum FactCheckTextRunner {

    /// One claim's passage through the run, in the order the run fills it in.
    private struct Work {
        let claim: FactCheckClaim
        let index: Int
        var claimId: String?
        var verdict: FactCheckVerdict?
        var annotations: [String: [String: String]] = [:]
        /// Whether this claim can still receive annotations, i.e. whether Flow A located a range
        /// for it. Unknown (true) until a read shows the row.
        var annotationExpected = true
        var errors: [String] = []
    }

    /// How long the backend takes to write the row that names a claim. The preclassify worker
    /// closes its stream the moment the model is done and only then embeds, matches and links, so a
    /// read taken immediately misses a link that landed a second later (measured in the tab:
    /// +857ms close, +1537ms link). The tab's own window for this is 2 seconds.
    private static let linkWait: UInt64 = 2_000_000_000

    /// How long Flow A's annotation gets between the first read back and the second. The
    /// annotation runs in the worker's `waitUntil`, i.e. strictly AFTER the research stream has
    /// closed, so no read taken on the stream's own tail can see it: measured 2026-10-27, the row
    /// still carried no annotation key 88 ms after the stream ended and carried one 3.3 s later.
    /// (A refused claim's empty review is the exception — 55 ms.) The wait has to stay short
    /// because the whole action is killed around 30 s: a run that spent 8 s on the network and
    /// then slept 25 s was ending at +35 s, past the point where Shortcuts had already reported
    /// "an unknown error occurred". Two attempts keeps the metered read count bounded; a claim
    /// whose annotation is still being written is returned without it.
    private static let annotationWait: UInt64 = 3_000_000_000

    // MARK: - Entry

    static func run(
        rawText: String,
        contextBefore: String?,
        contextAfter: String?,
        noFactChecking: Bool?,
        datetime: String?
    ) async -> String {
        let spec: Spec
        do {
            spec = try Spec(rawText: rawText, contextBefore: contextBefore, contextAfter: contextAfter, noFactChecking: noFactChecking, datetime: datetime)
        } catch {
            return encode([], outer: [message(for: error)], includeResults: true)
        }

        // What a run needs is a signed-in device, not a popup that has been opened: the app keeps
        // its own session and renews it (see AppSession), so an automation running days after the
        // last time anything was on screen still works. The renewal itself happens on the first
        // request, well inside the roughly 30 seconds an intent is given. Said as the tab says it
        // — the sentence already exists and is translated.
        guard FactCheckClient.canAuthenticate else {
            return encode([], outer: [FactCheckError.sessionUnavailable.errorDescription ?? ""], includeResults: true)
        }

        let locale = FactCheckClient.uiLocale
        let input = spec.input()

        var claims: [FactCheckClaim] = []
        do {
            for try await settled in FactCheckClient.preclassify(input: input, locale: locale) {
                claims = settled
            }
        } catch {
            return encode([], outer: [message(for: error)], includeResults: !spec.noFactChecking)
        }

        guard !claims.isEmpty else {
            return encode([], outer: [String(localized: "No verifiable claims were found in this text.")], includeResults: !spec.noFactChecking)
        }

        // Nothing buys a verdict or an annotation when the flag is set, so the run stops at the
        // claim boundaries it came for — no row read, no research, no charge beyond preclassification.
        guard !spec.noFactChecking else {
            let work = claims.enumerated().map { Work(claim: $1, index: $0) }
            return encode(work, outer: [], includeResults: false)
        }

        return await classify(claims: claims, input: input, locale: locale)
    }

    // MARK: - Classification

    private static func classify(claims: [FactCheckClaim], input: FactCheckInput, locale: String) async -> String {
        var work = claims.enumerated().map { Work(claim: $1, index: $0) }
        let hash = FactCheckClient.hash(of: input)

        // The link that names each claim, and any verdict the backend already holds for it: the
        // same cache read the tab makes, and the only thing standing between the user and being
        // charged again for a text that has already been classified.
        try? await Task.sleep(nanoseconds: linkWait)
        let cached = await FactCheckClient.cachedRows(for: input, locale: locale)
        adopt(cached, into: &work)

        var outer: [String] = []
        var halted: String?

        for index in work.indices {
            if let halted {
                work[index].errors.append(halted)
                continue
            }
            guard work[index].verdict == nil else { continue }   // already answered by the cache read

            let locators = FactCheckClient.ClaimLocators(
                tweetHash: hash,
                tweetText: input.fullText,
                textLocale: locale,
                claimIndex: work[index].index,
                claimId: work[index].claimId
            )

            do {
                // `research` normalizes the claim before sending it, because that is how
                // preclassification stored it and the backend matches on exact text.
                var settled: FactCheckVerdict?
                for try await verdict in FactCheckClient.research(claim: work[index].claim.rewritten, locale: locale, locators: locators) {
                    settled = verdict
                }
                if let settled {
                    work[index].verdict = settled
                } else {
                    work[index].errors.append(String(localized: "Something went wrong on our end. Please try again in a moment."))
                }
            } catch let error {
                let text = message(for: error)
                work[index].errors.append(text)
                // A refusal that will refuse every claim after it — no session, no balance, a
                // suspended account — is said once and ends the batch, rather than being bought
                // again for each remaining claim.
                if halts(error) {
                    halted = text
                    outer.append(text)
                }
            }
        }

        // Flow A annotates each claim server-side after its research stream has closed, so the
        // annotations are a write to read back rather than anything either stream carries. Bounded
        // to two attempts, and skipped outright once every claim that can be annotated has one.
        //
        // A claim's id is NOT the test for that. The id comes from the read taken two seconds
        // after preclassification, which lands before the detached link pipeline has finished for
        // anything but the first claim — so a claim the read missed has no id and may still have
        // been annotated. Waiting on the id alone skipped the read for exactly those claims, and
        // the annotations never reached the output at all.
        //
        // What Flow A actually refuses is a claim with no range located in this revision of the
        // body: it settles `no_key` and writes nothing, so such a claim is not worth another
        // metered read. `annotationExpected` therefore starts true (unknown) and is cleared by a
        // read that shows either no range, or a review already recorded for this body — the
        // pipeline persists an empty range dict for a claim it found clean, which is exactly what
        // a true verdict produces, so the absence of ranges is NOT itself evidence of an owed
        // annotation. A claim with no row yet keeps waiting.
        //
        // The read comes first, because the row is the only evidence that Flow A has run and it
        // usually has by the time the research stream closes. Sleeping before looking made every
        // fresh run pay the wait even when nothing was owed — and past the point the system keeps
        // a background intent alive, which is a failed action rather than a slow one.
        for attempt in 0..<2 {
            if work.allSatisfy({ !$0.annotations.isEmpty || !$0.annotationExpected }) {
                break
            }
            if attempt > 0 { try? await Task.sleep(nanoseconds: annotationWait) }
            let rows = await FactCheckClient.cachedRows(for: input, locale: locale)
            for index in work.indices {
                guard let row = row(for: work[index].claim, in: rows) else { continue }
                if work[index].claimId == nil { work[index].claimId = row.id }
                work[index].annotationExpected = row.highlight != nil
                    && !FactCheckClient.reviewRecorded(row, body: input.fullText)
                if !row.annotations.isEmpty { work[index].annotations = row.annotations }
            }
        }

        return encode(work, outer: outer, includeResults: true)
    }

    /// Fills in what the backend already holds: the claim's id, the verdict when it is current,
    /// and any annotations. A verdict past its reclassification date is left out on purpose —
    /// that is the row "Fact-Check All" runs again.
    private static func adopt(_ rows: [FactCheckClient.ClaimRow], into work: inout [Work]) {
        for index in work.indices {
            guard let row = row(for: work[index].claim, in: rows) else { continue }
            work[index].claimId = row.id
            if !row.annotations.isEmpty { work[index].annotations = row.annotations }
            guard row.isAnswered, !row.reclassify else { continue }
            work[index].verdict = FactCheckVerdict(
                confidence: row.probability,
                veracity: row.veracity,
                reasoning: row.reasoning ?? "",
                sources: row.sources
            )
        }
    }

    /// A row belongs to a claim when it names the same claim. Both sides are normalized because
    /// that is the form preclassification wrote.
    private static func row(for claim: FactCheckClaim, in rows: [FactCheckClient.ClaimRow]) -> FactCheckClient.ClaimRow? {
        let target = FactCheckClient.normalizeText(claim.rewritten)
        return rows.first { FactCheckClient.normalizeText($0.claim ?? "") == target }
    }

    // MARK: - Output

    /// The document the action returns: one entry per rewritten claim text, each an array (two
    /// claims that rewrite to the same words do not overwrite one another), plus an `error-messages`
    /// array on the outside for a failure that stopped the run before any claim could be named.
    private static func encode(_ work: [Work], outer: [String], includeResults: Bool) -> String {
        var byClaim: [String: [[String: Any]]] = [:]

        for item in work {
            var object: [String: Any] = ["raw-text": item.claim.rawText]
            // Whether the post's link flags the claim (`tweet_claims.is_hidden`): the page keeps
            // such a claim out of sight until a selection uncovers that part of the post. On
            // every entry rather than only when true — a flag the reader has to infer from an
            // absent key is a flag the reader cannot tell from an omitted one.
            object["is_hidden"] = item.claim.isHidden
            if includeResults {
                if let verdict = item.verdict {
                    if let confidence = verdict.confidence { object["confidence-percentage"] = percent(confidence) }
                    if let veracity = verdict.veracity { object["veracity-percentage"] = percent(veracity) }
                    object["reasoning"] = verdict.reasoning
                    object["sources"] = sourceDictionary(verdict.sources)
                }
                object["annotations"] = item.annotations
            }
            if !item.errors.isEmpty { object["error-messages"] = item.errors }
            byClaim[item.claim.rewritten, default: []].append(object)
        }

        var root: [String: Any] = [:]
        for (claim, entries) in byClaim { root[claim] = entries }
        if !outer.isEmpty { root["error-messages"] = outer }

        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .prettyPrinted]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// A score as the whole percentage the app shows, so what an automation reads is what the tab
    /// would have put on screen. The arithmetic is the same for both fields for a reason: 0.923
    /// scaled in binary floating point is 92.30000000000001, and an API that hands that back makes
    /// its callers round.
    ///
    /// Veracity keeps its sign, which is not a detail of this formatting but the field itself:
    /// positive is true, negative is false, and only the magnitude is how far that way. Confidence
    /// has no direction to carry.
    private static func percent(_ score: Double) -> Int {
        Int((score * 100).rounded())
    }

    /// The sources as the database holds them: a `URL → title` dictionary. The client flattens that
    /// map into a list as it reads it, so it is rebuilt here rather than returned in the list shape
    /// only this app uses.
    private static func sourceDictionary(_ sources: [FactCheckSource]) -> [String: String] {
        var out: [String: String] = [:]
        for source in sources {
            guard let key = source.url ?? source.title, !key.isEmpty else { continue }
            out[key] = source.title ?? ""
        }
        return out
    }

    // MARK: - Failures

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    /// Whether a failure means every remaining claim would fail the same way: no live session, no
    /// balance, a suspended account. The workers say so with a status, which is the part of their
    /// answer that does not move.
    private static func halts(_ error: Error) -> Bool {
        switch error {
        case FactCheckError.sessionUnavailable:
            return true
        case FactCheckError.worker(let status, _):
            return status == 401 || status == 402 || status == 403
        default:
            return false
        }
    }

    // MARK: - Input

    /// What the action was asked to check, whether it arrived as fields or as a JSON object.
    ///
    /// A class because a post carries its quoted post and its reply parent, each of which carries
    /// its own, and a struct cannot hold itself.
    private final class Spec {
        let text: String
        let username: String
        let usertype: String
        /// The four the action's own fields can also supply, so they are the four that are
        /// overwritten after parsing rather than fixed at it.
        var contextBefore: String?
        var contextAfter: String?
        var noFactChecking: Bool
        /// The date the text's post is written, as an ISO 8601 instant in UTC. The fourth field the
        /// action's own fields can also supply, and the one the wire acts on: the preclassify worker
        /// dates its own instructions from it, so an old post's claims are judged as of its own
        /// moment rather than as of today. It reaches nothing else — not the hash, and not the
        /// model's view of the post, which carries the text and the account alone.
        var datetime: String?
        let quoting: Spec?
        let replyingTo: Spec?

        /// The standings the preclassify worker accepts. An empty string is a caller saying there
        /// is no account behind the text, which is the ordinary case here.
        private static let usertypes = ["Business", "Government", "Verified", "None"]

        /// Any of these in a JSON object means the object is the input rather than a text that
        /// happens to be valid JSON.
        private static let recognizedKeys: Set<String> = [
            "text", "fullText", "username", "usertype",
            "context-before", "contextBefore", "context-after", "contextAfter",
            "no-fact-checking", "noFactChecking", "datetime", "quoting", "replyingTo",
        ]

        init(
            text: String,
            username: String,
            usertype: String,
            contextBefore: String?,
            contextAfter: String?,
            noFactChecking: Bool,
            datetime: String?,
            quoting: Spec?,
            replyingTo: Spec?
        ) {
            self.text = text
            self.username = username
            self.usertype = usertype
            self.contextBefore = contextBefore
            self.contextAfter = contextAfter
            self.noFactChecking = noFactChecking
            self.datetime = datetime
            self.quoting = quoting
            self.replyingTo = replyingTo
        }

        convenience init(rawText: String, contextBefore: String?, contextAfter: String?, noFactChecking: Bool?, datetime: String?) throws {
            let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            if let object = Self.object(from: trimmed),
               object.keys.contains(where: { Self.recognizedKeys.contains($0) }) {
                try self.init(json: object)
            } else {
                // A bare text: no before/after context, no account, no date, and every claim
                // researched.
                self.init(
                    text: rawText,
                    username: "",
                    usertype: "None",
                    contextBefore: nil,
                    contextAfter: nil,
                    noFactChecking: false,
                    datetime: nil,
                    quoting: nil,
                    replyingTo: nil
                )
            }
            // A field the user filled in wins over the same field inside the JSON, so the two ways
            // of supplying the input can be mixed without one silently overriding the other.
            if let contextBefore = contextBefore { self.contextBefore = contextBefore }
            if let contextAfter = contextAfter { self.contextAfter = contextAfter }
            if let noFactChecking = noFactChecking { self.noFactChecking = noFactChecking }
            if let datetime = datetime { self.datetime = datetime }
        }

        convenience init(json object: [String: Any]) throws {
            guard let body = Self.firstString(object, "text", "fullText"), !body.isEmpty else {
                throw SpecError.missingText
            }
            let usertype = Self.firstString(object, "usertype") ?? "None"
            guard usertype.isEmpty || Self.usertypes.contains(usertype) else {
                throw SpecError.unknownUsertype(usertype)
            }
            self.init(
                text: body,
                username: Self.firstString(object, "username") ?? "",
                usertype: usertype,
                contextBefore: Self.firstString(object, "context-before", "contextBefore"),
                contextAfter: Self.firstString(object, "context-after", "contextAfter"),
                noFactChecking: Self.firstBool(object, "no-fact-checking", "noFactChecking") ?? false,
                datetime: Self.firstString(object, "datetime"),
                quoting: try Self.firstObject(object, "quoting").map { try Spec(json: $0) },
                replyingTo: try Self.firstObject(object, "replyingTo").map { try Spec(json: $0) }
            )
        }

        /// The tweet-shaped envelope the preclassify worker validates its input against, built from
        /// what the action was given. `fullText` is the whole text: unlike a tweet, a text handed to
        /// this action has no truncation and no note expansion, so the two are the same string.
        func input() -> FactCheckInput {
            FactCheckInput(
                text: text,
                username: username,
                usertype: usertype,
                contextBefore: contextBefore,
                contextAfter: contextAfter,
                quoting: quoting?.context(),
                replyingTo: replyingTo?.context(),
                datetime: datetime
            )
        }

        /// The same node as the wire carries it when it stands around another post rather than
        /// being the one under check.
        func context() -> FactCheckContext {
            FactCheckContext(
                text: text,
                username: username,
                usertype: usertype,
                contextBefore: contextBefore,
                contextAfter: contextAfter,
                quoting: quoting?.context(),
                replyingTo: replyingTo?.context()
            )
        }

        private static func object(from text: String) -> [String: Any]? {
            guard text.hasPrefix("{"), let data = text.data(using: .utf8) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }

        private static func firstString(_ object: [String: Any], _ keys: String...) -> String? {
            for key in keys {
                if let value = object[key] as? String { return value }
            }
            return nil
        }

        private static func firstBool(_ object: [String: Any], _ keys: String...) -> Bool? {
            for key in keys {
                if let value = object[key] as? Bool { return value }
            }
            return nil
        }

        private static func firstObject(_ object: [String: Any], _ key: String) -> [String: Any]? {
            object[key] as? [String: Any]
        }
    }

    /// A malformed input, in plain English: these are the shapes the preclassify worker would
    /// refuse with a 400, said before anything is sent or charged.
    private enum SpecError: LocalizedError {
        case missingText
        case unknownUsertype(String)

        var errorDescription: String? {
            switch self {
            case .missingText:
                return "The input JSON has no \"text\" field to fact-check."
            case .unknownUsertype(let value):
                return "The input JSON's \"usertype\" is \"\(value)\", which is not one of Business, Government, Verified or None."
            }
        }
    }
}
