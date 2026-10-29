#!/usr/bin/env bash
# Fetches the Trustless Work single-release v1 escrow Wasm that is deployed on Stellar testnet and
# mainnet, by its on-chain Wasm hash, and checks it against SHA256SUMS.
#
# The files are used ONLY by the guard contract tests (contracts/guard/src/test.rs), which run every
# guard rule against the real deployed escrow code. They are git-ignored and never redistributed.
# TODO(verify): Trustless Work's license for the compiled Wasm before ever committing these files.
#
# Read-only: this makes RPC reads (getLedgerEntries) and never signs or submits a transaction.
#
# Usage:
#   ./fetch.sh                 fetch both (skips files that already match their hash)
#   ./fetch.sh testnet         testnet only
#   ./fetch.sh mainnet         mainnet only
#
# Environment:
#   TW_TESTNET_RPC_URL   default https://soroban-testnet.stellar.org
#   TW_MAINNET_RPC_URL   required for the mainnet file: any Stellar mainnet RPC endpoint
#                        (the mainnet Wasm is only read, never deployed to)
#   TW_WASM_SRC_DIR      optional: a directory that already holds the two files (offline/CI cache);
#                        they are copied from there and still verified by hash
#
# Requires: the Stellar CLI (`stellar contract fetch --wasm-hash`, checked against stellar 23.4.0)
# and shasum or sha256sum.
set -euo pipefail

cd "$(dirname "$0")"

TESTNET_HASH="7c3f7b2af92ad86092708b23babf80f9e1308d7f3ce18b703b9499192ecc934b"
MAINNET_HASH="96d51751f924c938a081deb740056dc1c5cc60c6e645672062531f82957ed2fe"
TESTNET_FILE="tw_testnet_7c3f7b2a.wasm"
MAINNET_FILE="tw_mainnet_96d51751.wasm"
TESTNET_PASSPHRASE="Test SDF Network ; September 2015"
MAINNET_PASSPHRASE="Public Global Stellar Network ; September 2015"
TESTNET_RPC="${TW_TESTNET_RPC_URL:-https://soroban-testnet.stellar.org}"
MAINNET_RPC="${TW_MAINNET_RPC_URL:-}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

matches() { [ -f "$1" ] && [ "$(sha256 "$1")" = "$2" ]; }

fetch_one() {
  local name="$1" hash="$2" file="$3" rpc="$4" passphrase="$5"
  if matches "$file" "$hash"; then
    echo "ok    $file (already present, sha256 matches)"
    return 0
  fi
  rm -f "$file"
  if [ -n "${TW_WASM_SRC_DIR:-}" ] && [ -f "$TW_WASM_SRC_DIR/$file" ]; then
    cp "$TW_WASM_SRC_DIR/$file" "$file"
  else
    if [ -z "$rpc" ]; then
      echo "error $file: set TW_MAINNET_RPC_URL to a Stellar mainnet RPC endpoint (read-only use)" >&2
      return 1
    fi
    if ! command -v stellar >/dev/null 2>&1; then
      echo "error: the Stellar CLI is required (https://developers.stellar.org/docs/tools/cli)" >&2
      return 1
    fi
    echo "fetch $file from $name ($rpc)"
    # Note: a Wasm code entry can be archived by the network; if this fails with a missing or
    # archived entry, the code must be restored on that network before it can be fetched.
    stellar contract fetch --wasm-hash "$hash" --out-file "$file" \
      --rpc-url "$rpc" --network-passphrase "$passphrase"
  fi
  local got
  got="$(sha256 "$file")"
  if [ "$got" != "$hash" ]; then
    echo "error $file: sha256 $got does not match $hash" >&2
    rm -f "$file"
    return 1
  fi
  echo "ok    $file sha256 $hash"
}

which_net="${1:-all}"
case "$which_net" in
  testnet) fetch_one testnet "$TESTNET_HASH" "$TESTNET_FILE" "$TESTNET_RPC" "$TESTNET_PASSPHRASE" ;;
  mainnet) fetch_one mainnet "$MAINNET_HASH" "$MAINNET_FILE" "$MAINNET_RPC" "$MAINNET_PASSPHRASE" ;;
  all)
    fetch_one testnet "$TESTNET_HASH" "$TESTNET_FILE" "$TESTNET_RPC" "$TESTNET_PASSPHRASE"
    fetch_one mainnet "$MAINNET_HASH" "$MAINNET_FILE" "$MAINNET_RPC" "$MAINNET_PASSPHRASE"
    ;;
  *) echo "usage: $0 [testnet|mainnet|all]" >&2; exit 2 ;;
esac

# Cross-check against the committed SHA256SUMS as well (catches an edit to one list but not the other).
if [ "$which_net" = "all" ]; then
  while read -r want file; do
    [ "$(sha256 "$file")" = "$want" ] || { echo "error: $file does not match SHA256SUMS" >&2; exit 1; }
  done < SHA256SUMS
fi
