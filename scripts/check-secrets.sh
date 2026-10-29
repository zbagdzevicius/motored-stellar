#!/usr/bin/env bash
# Fails (exit 1) if the repository contains anything that looks like a secret.
#
#   1. a Stellar secret seed: "S" followed by 55 base32 characters;
#   2. a seed phrase assigned to a mnemonic / seed-phrase / recovery-phrase field;
#   3. a .env file (any name starting with ".env");
#   4. a private key: a PEM private-key block, a JSON key file (service-account style
#      "private_key", or a "secret"/"secretKey"/"seed" field), or a *.secret.json file;
#   5. tracked local key material (.keys/, .stellar/).
#
# Scans `git ls-files -co --exclude-standard` (what a commit could contain) inside a git
# repository, otherwise every file under the repository root except build output.
# Never prints a matched value: findings show the file, line number and rule only.
#
# Usage: scripts/check-secrets.sh [rootDir]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
SELF="scripts/check-secrets.sh"

list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Tracked files plus untracked files that are not ignored: what a commit could contain
    # (works before the first commit too, so git-ignored .keys/ is never scanned).
    git ls-files -co --exclude-standard
  else
    find . -type f \
      -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/target/*' \
      -not -path '*/dist/*' -not -path '*/coverage/*' | sed 's|^\./||'
  fi
}

fail=0
report() { # file, line, rule
  printf 'check-secrets: %s:%s: %s\n' "$1" "$2" "$3" >&2
  fail=1
}

SECRET_SEED='(^|[^A-Z2-7])S[A-Z2-7]{55}([^A-Z2-7]|$)'
MNEMONIC='(mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase|seed[_ -]?words)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[a-z]+([[:space:]]+[a-z]+){11,23}'
PEM_PRIVATE='-----BEGIN [A-Z ]*PRIVATE KEY-----'
JSON_SECRET='"(private_key|privateKey|secret|secretKey|secret_key|seed)"[[:space:]]*:[[:space:]]*"[^"<$]{16,}"'

while IFS= read -r f; do
  [ -f "$f" ] || continue
  base="${f##*/}"

  case "$f" in
    .keys/*|*/.keys/*|.stellar/*|*/.stellar/*) report "$f" 0 "local key material is tracked"; continue ;;
  esac
  case "$base" in
    .env|.env.*|.env*) report "$f" 0 ".env file"; continue ;;
    *.secret.json) report "$f" 0 "*.secret.json file"; continue ;;
  esac
  [ "$f" = "$SELF" ] && continue
  case "$base" in
    *.wasm|*.png|*.jpg|*.jpeg|*.gif|*.ico|*.pdf|*.woff|*.woff2|*.ttf|*.lock|package-lock.json) continue ;;
  esac
  # Skip binary files.
  if ! grep -Iq . "$f" 2>/dev/null; then continue; fi

  while IFS=: read -r line _; do report "$f" "$line" "Stellar secret seed (S...)"; done \
    < <(grep -nE "$SECRET_SEED" "$f" || true)
  while IFS=: read -r line _; do report "$f" "$line" "seed phrase"; done \
    < <(grep -niE "$MNEMONIC" "$f" || true)
  while IFS=: read -r line _; do report "$f" "$line" "PEM private key"; done \
    < <(grep -nE -e "$PEM_PRIVATE" "$f" || true)
  case "$base" in
    *.json)
      while IFS=: read -r line _; do report "$f" "$line" "secret field in JSON key file"; done \
        < <(grep -nE "$JSON_SECRET" "$f" || true)
      ;;
  esac
done < <(list_files)

if [ "$fail" -ne 0 ]; then
  echo "check-secrets: FAILED. Remove the material above; never commit keys, seeds or .env files." >&2
  exit 1
fi
echo "check-secrets: OK"
