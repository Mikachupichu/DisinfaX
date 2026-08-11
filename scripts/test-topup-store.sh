#!/usr/bin/env bash
# Executable checks for the Apple top-up shared store.
#
# This file is the record-keeping layer between a completed Apple purchase and a credited
# balance. If it loses a record, a customer has paid and been given nothing; if it duplicates
# one, they are credited twice; if it forgets a finishable id, that dollar amount silently
# becomes un-buyable because StoreKit keeps handing back the open transaction. None of that
# surfaces as a crash, so it needs assertions rather than inspection.
#
# The shipped source is compiled AS IS except for the App Group identifier, which is swapped
# for a throwaway suite so a test run can never read or write the real container. The swap is
# printed as a diff so the substitution stays honest.
#
#   Usage: bash scripts/test-topup-store.sh
#   Exit:  0 = all assertions passed
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/DisinfaX/Shared (App)/SharedTopUpStore.swift"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SOURCE" ] || { echo "cannot find $SOURCE" >&2; exit 1; }

python3 - "$SOURCE" "$WORK/SharedTopUpStore.swift" <<'PYEOF'
import sys, difflib
src = open(sys.argv[1]).read()
old = '''        ["WJFG5784YR.group.app.disinfax", "group.app.disinfax"]
#else
        ["group.app.disinfax", "WJFG5784YR.group.app.disinfax"]'''
new = '''        ["app.disinfax.storetest.throwaway"]
#else
        ["app.disinfax.storetest.throwaway"]'''
if old not in src:
    sys.exit("app group candidates not found — SharedTopUpStore.swift changed shape, update this script")
patched = src.replace(old, new, 1)
open(sys.argv[2], 'w').write(patched)
changed = [l for l in difflib.unified_diff(src.splitlines(), patched.splitlines(), lineterm='')
           if l.startswith(('+', '-')) and not l.startswith(('+++', '---'))]
print(f"substituted app group only ({len(changed)} lines differ from the shipped file):")
for l in changed:
    print("   ", l.strip())
if len(changed) != 4:
    sys.exit("unexpected number of substitutions; refusing to test a file that differs elsewhere")
PYEOF

cat > "$WORK/suite.swift" <<'SWIFT'
import Foundation

private let suiteName = "app.disinfax.storetest.throwaway"

private func reset() {
    let d = UserDefaults(suiteName: suiteName)!
    for k in d.dictionaryRepresentation().keys { d.removeObject(forKey: k) }
}

func runSuite() -> Int {
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        if ok { print("ok    \(name)") } else { failures += 1; print("FAIL  \(name)  \(detail)") }
    }

    check("app group resolves (probe round-trips)", SharedTopUpStore.isAvailable)

    // ── A charge must never be silently dropped ──────────────────────────────
    reset()
    SharedTopUpStore.appendPendingTransaction(jws: "jws-A", transactionId: "1", amount: 1)
    SharedTopUpStore.appendPendingTransaction(jws: "jws-B", transactionId: "2", amount: 3)
    check("two different purchases both retained", SharedTopUpStore.pendingTransactions().count == 2)
    check("  first purchase survives the second", SharedTopUpStore.isPending(transactionId: "1"))
    check("  amounts preserved per transaction",
          SharedTopUpStore.pendingTransactions().first(where: { $0.transactionId == "2" })?.amount == 3)
    check("  receipt preserved verbatim",
          SharedTopUpStore.pendingTransactions().first(where: { $0.transactionId == "1" })?.jws == "jws-A")

    // ── The same charge must never be recorded twice ─────────────────────────
    reset()
    SharedTopUpStore.appendPendingTransaction(jws: "jws-A", transactionId: "1", amount: 1)
    SharedTopUpStore.appendPendingTransaction(jws: "jws-A2", transactionId: "1", amount: 1)
    check("re-recording the same transaction does not duplicate it",
          SharedTopUpStore.pendingTransactions().count == 1)
    check("  the newer receipt wins", SharedTopUpStore.pendingTransactions().first?.jws == "jws-A2")

    // ── Clearing one credited charge must not discard the others ─────────────
    reset()
    for (i, amt) in [(1, 1), (2, 3), (3, 5)] {
        SharedTopUpStore.appendPendingTransaction(jws: "j\(i)", transactionId: "\(i)", amount: amt)
    }
    SharedTopUpStore.clearPendingTransaction(transactionId: "2")
    check("clearing one leaves the rest", SharedTopUpStore.pendingTransactions().count == 2)
    check("  the right one was cleared", !SharedTopUpStore.isPending(transactionId: "2"))
    check("  uncredited ones remain",
          SharedTopUpStore.isPending(transactionId: "1") && SharedTopUpStore.isPending(transactionId: "3"))
    SharedTopUpStore.clearPendingTransaction(transactionId: "nonexistent")
    check("clearing an unknown id is a no-op, not a wipe", SharedTopUpStore.pendingTransactions().count == 2)

    // ── The leak guard drops the OLDEST, never the newest ────────────────────
    reset()
    for i in 1...25 { SharedTopUpStore.appendPendingTransaction(jws: "j\(i)", transactionId: "\(i)", amount: 1) }
    check("record list is capped", SharedTopUpStore.pendingTransactions().count == 20)
    check("  newest purchase survives the cap", SharedTopUpStore.isPending(transactionId: "25"))
    check("  oldest was the one dropped", !SharedTopUpStore.isPending(transactionId: "1"))

    // ── Amount fallback chain ───────────────────────────────────────────────
    reset()
    check("no hint at all falls back to $5", SharedTopUpStore.initialAmount() == 5)
    SharedTopUpStore.lastAmount = 7
    check("falls back to the last entered amount", SharedTopUpStore.initialAmount() == 7)
    SharedTopUpStore.setRequestedAmount(12)
    check("a request from the popup wins", SharedTopUpStore.initialAmount() == 12)
    check("  and is consumed, not sticky", SharedTopUpStore.initialAmount() == 7)
    SharedTopUpStore.setRequestedAmount(9999)
    check("an out-of-range request is clamped to 100", SharedTopUpStore.initialAmount() == 100)
    SharedTopUpStore.setRequestedAmount(0)
    check("a zero request is clamped to 1", SharedTopUpStore.initialAmount() == 1)
    SharedTopUpStore.setRequestedAmount(-4)
    check("a negative request is clamped to 1", SharedTopUpStore.initialAmount() == 1)

    // ── A malformed record is skipped, never fabricated ─────────────────────
    reset()
    UserDefaults(suiteName: suiteName)!.set(
        [["transactionId": "9"], ["jws": "j", "transactionId": "10", "amount": 2]],
        forKey: "topup.pending.records")
    check("record missing its receipt is skipped", SharedTopUpStore.pendingTransactions().count == 1)
    check("  the valid record still parses", SharedTopUpStore.pendingTransactions().first?.transactionId == "10")

    // ── Credited-and-awaiting-close-out list ────────────────────────────────
    reset()
    check("nothing finishable to begin with", SharedTopUpStore.finishableTransactions().isEmpty)
    SharedTopUpStore.markFinishable(transactionId: "100")
    check("a credited id is recorded", SharedTopUpStore.finishableTransactions() == ["100"])
    SharedTopUpStore.markFinishable(transactionId: "100")
    check("  marking twice does not duplicate", SharedTopUpStore.finishableTransactions() == ["100"])
    SharedTopUpStore.markFinishable(transactionId: "101")
    check("  a second id is appended", SharedTopUpStore.finishableTransactions() == ["100", "101"])
    SharedTopUpStore.clearFinishable(transactionId: "100")
    check("clearing one leaves the other", SharedTopUpStore.finishableTransactions() == ["101"])
    SharedTopUpStore.clearFinishable(transactionId: "999")
    check("clearing an unknown id is a no-op", SharedTopUpStore.finishableTransactions() == ["101"])
    SharedTopUpStore.clearFinishable(transactionId: "101")
    check("clearing the last removes the key", SharedTopUpStore.finishableTransactions().isEmpty)

    reset()
    for i in 1...25 { SharedTopUpStore.markFinishable(transactionId: "\(i)") }
    let ids = SharedTopUpStore.finishableTransactions()
    check("finishable list is capped", ids.count == 20)
    check("  newest retained", ids.contains("25"))
    check("  oldest dropped", !ids.contains("1"))

    // ── Signed in vs signed out: the check that decides if money may be taken ──
    // This is a hole that shipped: userId was written and never cleared, so signing out of the
    // popup left the app holding the previous identity and it happily completed a purchase.
    reset()
    check("nobody is signed in on a blank store", SharedTopUpStore.userId == nil)

    SharedTopUpStore.setAccount(userId: "user-A", balance: 12.5)
    check("a synced account reads back", SharedTopUpStore.userId == "user-A")
    check("  with its balance", SharedTopUpStore.balance == 12.5)

    SharedTopUpStore.clearAccount()
    check("sign-out clears the identity", SharedTopUpStore.userId == nil)
    check("  and the balance", SharedTopUpStore.balance == nil)

    // Money already owed must survive a sign-out; it is the only local record of it.
    reset()
    SharedTopUpStore.setAccount(userId: "user-A", balance: 5)
    SharedTopUpStore.appendPendingTransaction(jws: "j", transactionId: "300", amount: 2)
    SharedTopUpStore.markFinishable(transactionId: "301")
    SharedTopUpStore.clearAccount()
    check("sign-out keeps purchases already paid for", SharedTopUpStore.isPending(transactionId: "300"))
    check("  and ids awaiting close-out", SharedTopUpStore.finishableTransactions() == ["301"])
    check("  but still reports signed out", SharedTopUpStore.userId == nil)

    // The freshness stamp is the backstop for every sign-out that never reaches the app.
    reset()
    let d = UserDefaults(suiteName: suiteName)!
    d.set("user-A", forKey: "topup.userId")
    d.set(Date().addingTimeInterval(-6 * 24 * 60 * 60), forKey: "topup.accountSyncedAt")
    check("an identity from 6 days ago is still trusted", SharedTopUpStore.userId == "user-A")
    d.set(Date().addingTimeInterval(-8 * 24 * 60 * 60), forKey: "topup.accountSyncedAt")
    check("an identity from 8 days ago is not", SharedTopUpStore.userId == nil)

    reset()
    d.set("user-A", forKey: "topup.userId")   // no stamp at all, e.g. written by an older build
    check("an unstamped identity is treated as signed out", SharedTopUpStore.userId == nil)

    reset()
    d.set("", forKey: "topup.userId")
    d.set(Date(), forKey: "topup.accountSyncedAt")
    check("an empty user id is signed out, not a valid account", SharedTopUpStore.userId == nil)

    // ── The two lists are independent ───────────────────────────────────────
    reset()
    SharedTopUpStore.appendPendingTransaction(jws: "j", transactionId: "200", amount: 2)
    SharedTopUpStore.markFinishable(transactionId: "201")
    SharedTopUpStore.clearFinishable(transactionId: "201")
    check("clearing finishable does not touch owed records", SharedTopUpStore.isPending(transactionId: "200"))
    SharedTopUpStore.markFinishable(transactionId: "202")
    SharedTopUpStore.clearPendingTransaction(transactionId: "200")
    check("clearing an owed record does not touch finishable",
          SharedTopUpStore.finishableTransactions() == ["202"])

    reset()
    return failures
}
SWIFT

cat > "$WORK/main.swift" <<'SWIFT'
import Foundation
let failures = runSuite()
print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
exit(failures == 0 ? 0 : 1)
SWIFT

echo
xcrun swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos13.0 \
  -o "$WORK/storetest" \
  "$WORK/SharedTopUpStore.swift" "$WORK/suite.swift" "$WORK/main.swift"

"$WORK/storetest"
