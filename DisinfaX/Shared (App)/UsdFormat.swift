import Foundation

/// Locale-aware presentation of USD amounts ("US$3.24" vs "3,24 US$").
///
/// The symbol text is always this app's "US$" branding — a bare "$" in front of a Canadian or
/// Australian customer states a price that is not what Apple will charge them — but the POSITION
/// follows the device locale's own USD convention, probed from NumberFormatter rather than a
/// hard-coded per-language table so every locale behaves correctly. The suffix form uses a
/// non-breaking space (matching the platform convention) so the number and currency never wrap
/// onto separate lines.
///
/// Mirrors the extension popup's usdSymbolAfterAmount (entrypoints/popup/i18n.ts) — kept local
/// because the app target cannot import the extension bundle.
enum UsdFormat {

    /// True when the device locale writes a currency symbol AFTER the number (e.g. French).
    /// Falls back to prefix when the locale is unrecognized.
    static var symbolAfterAmount: Bool {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.locale = Locale.autoupdatingCurrent
        // formatToParts equivalent: locate the currency token vs the integer token. There is
        // no public parts API on NumberFormatter, so probe with a value whose digits cannot
        // collide with the symbol text.
        guard let rendered = formatter.string(from: 1) else { return false }
        let currencySymbol = formatter.currencySymbol ?? "$"
        guard let currencyRange = rendered.range(of: currencySymbol),
              let digitRange = rendered.rangeOfCharacter(from: .decimalDigits) else { return false }
        return currencyRange.lowerBound > digitRange.lowerBound
    }

    /// A USD amount as one string, symbol and all, in the locale's own position — for plain text,
    /// such as a notification body, where there is no font to size a part of it with.
    static func string(from value: Double) -> String {
        let number = number(from: value)
        // Non-breaking space in the suffix form, matching the platform convention.
        return symbolAfterAmount ? "\(number) US$" : "US$\(number)"
    }

    /// The number alone: the same rounding, the same locale decimal separator, no symbol.
    ///
    /// For a caller that sets the currency mark beside it in two sizes rather than as one run —
    /// `TopUpView`'s amounts, which state "US" smaller than everything else. The rule lives here
    /// and `string(from:)` is built on it, so the plain-text and the typeset form of one balance
    /// cannot disagree about what that balance is.
    ///
    /// Four decimals, not two, and trailing zeros trimmed. The ledger is stored to four, and a
    /// fact-check costs a fraction of a cent, so two decimals rounded every small charge to a flat
    /// "US$0.00" — a notification that read as though nothing had been spent. Trimming keeps the
    /// ordinary amounts ordinary: a whole dollar stays "US$23" rather than becoming "US$23.0000".
    /// A lone decimal is padded back out, because "US$0.1" reads as an unfinished price.
    ///
    /// Mirrors the extension's `formatUsdNumber` (entrypoints/popup/i18n.ts) exactly, so the app and
    /// the popup state the same balance the same way.
    static func number(from value: Double) -> String {
        let rounded = (value * 10000).rounded() / 10000

        // Padded to four and stripped, rather than counted: the '.' halts the strip, so an integer
        // is left as "23." and counts as no decimals at all. A fixed format, so the separator here
        // is a '.' whatever the locale — only the padding is being measured, never printed.
        var padded = String(format: "%.4f", rounded)
        while padded.hasSuffix("0") { padded.removeLast() }
        let decimals: Int
        if let point = padded.firstIndex(of: ".") {
            decimals = padded.distance(from: padded.index(after: point), to: padded.endIndex)
        } else {
            decimals = 0
        }
        let fractionDigits = decimals == 0 ? 0 : (decimals == 1 ? 2 : decimals)

        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale.autoupdatingCurrent
        formatter.minimumFractionDigits = fractionDigits
        formatter.maximumFractionDigits = fractionDigits
        return formatter.string(from: NSNumber(value: rounded)) ?? String(format: "%.\(fractionDigits)f", rounded)
    }
}
