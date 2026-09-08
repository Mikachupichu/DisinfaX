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

    /// Format a USD amount with the locale's decimal separator and currency position
    /// (e.g. "US$3.24" in English, "3,24 US$" in French).
    static func string(from value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale.autoupdatingCurrent
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let number = formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
        // Non-breaking space in the suffix form, matching the platform convention.
        return symbolAfterAmount ? "\(number) US$" : "US$\(number)"
    }
}
