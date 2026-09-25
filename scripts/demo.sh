#!/usr/bin/env bash
# Hermetic evaluator demo — LP-0021/LP-0023 clean-room walkthrough.
#
# Runs entirely offline: builds the workspace, exercises the real wallet
# worker through the native-messaging daemon (init → accounts → blob
# round-trip), and typechecks the SDKs. No network, no credentials, no
# pre-existing state required beyond a Rust toolchain and Node.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}:$HOME/.local/share/wsp-pcsc/pkgconfig"

echo "== 1/4  build workspace =="
cargo build --workspace

echo "== 2/4  workspace tests =="
cargo test --workspace

echo "== 3/4  native-messaging smoke (real WalletCore) =="
python3 - <<'PY'
import json, struct, subprocess

proc = subprocess.Popen(
    ["./target/debug/wsp-lezd"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
)

def send(obj):
    data = json.dumps(obj).encode()
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()

def recv():
    (n,) = struct.unpack("<I", proc.stdout.read(4))
    return json.loads(proc.stdout.read(n))

send({"id": 1, "op": {"op": "ping"}})
r = recv()
assert r["ok"] and r["output"]["type"] == "pong"
print("  ping:", r["output"]["engine"])

send({"id": 2, "op": {"op": "init"}})
r = recv()
assert r["ok"]
blob = r["output"]["blob_b64"]
assert r["output"]["mnemonic"].count(" ") == 23
print("  init: 24-word mnemonic + storage blob")

send({"id": 3, "op": {"op": "create_account", "privacy": "public", "label": "demo"}})
r = recv()
acct = r["output"]["account_id"]
assert acct.startswith("Public/")
print("  account:", acct)

# The sealed-vault contract: export the blob after mutating ops, then prove
# the exported bytes restore the account on a fresh session.
send({"id": 4, "op": {"op": "export_blob"}})
blob2 = recv()["output"]["blob_b64"]

send({"id": 5, "op": {"op": "lock"}})
assert recv()["output"]["type"] == "locked"
send({"id": 6, "op": {"op": "unlock", "blob_b64": blob2}})
assert recv()["output"]["type"] == "unlocked"
send({"id": 7, "op": {"op": "list_accounts"}})
accounts = recv()["output"]["accounts"]
assert any(a["account_id"] == acct for a in accounts), accounts
print("  blob round-trip: account persisted across lock/unlock")

proc.stdin.close(); proc.wait(timeout=10)
assert proc.returncode == 0
print("  daemon exited cleanly on stdin close")
PY

echo "== 4/4  typescript SDK typecheck =="
npx tsc -p tsconfig.json

echo
echo "demo complete — wallet worker, daemon, and SDKs verified hermetically."
