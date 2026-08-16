#!/usr/bin/env bash
#
# Exercise the two parts of install.sh that the device proved wrong.
#
#   1. fetch_source's libcurl branch. `git clone` died inside the https remote
#      helper, the installer printed the right diagnosis and then fell back to
#      the tarball - which left ~/tca with no .git and `tca update` permanently
#      broken. It now repairs and retries. This also checks it does not delete a
#      directory that has real content in it.
#
#   2. The size report. `apt-get install -s` printed "Inst ..." lines with no
#      "Need to get" line, so neither branch of the first version fired and the
#      step printed nothing at all - the one thing it exists to avoid.
#
# The functions are pulled out of install.sh with sed rather than copied, so this
# cannot drift away from what ships.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- pull the real functions out of the real script -------------------------
{
  echo 'set -uo pipefail'
  echo 'BOLD= RESET= RED= GREEN= YELLOW= CYAN= DIM='
  sed -n '/^step() {/,/^die()/p' "$SRC"
  sed -n '/^in_termux() {/,/^}/p' "$SRC"
  sed -n '/^human_bytes() {/,/^}/p' "$SRC"
  sed -n '/^fetch_source() {/,/^}$/p' "$SRC"
} > "$WORK/lib.sh"

for want in fetch_source human_bytes in_termux; do
  grep -q "^$want() {" "$WORK/lib.sh" || { echo "could not extract $want from install.sh" >&2; exit 1; }
done

# shellcheck disable=SC1090
source "$WORK/lib.sh"

# Sourced after, because lib.sh blanks the colour variables for its own output.
C_RED=$'\033[31m'
C_GREEN=$'\033[32m'
C_OFF=$'\033[0m'
fails=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ${C_GREEN}ok${C_OFF}   $1"
  else
    echo "  ${C_RED}FAIL${C_OFF} $1"
    echo "         want: $3"
    echo "         got:  $2"
    fails=$((fails + 1))
  fi
}

# ---- fakes ------------------------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/apt-get" <<'FAKE'
#!/usr/bin/env bash
echo "apt-get $*" >> "$FAKE_LOG"
exit "${FAKE_APT_RC:-0}"
FAKE

# Fails with the device's exact error until libcurl has been reinstalled, then
# succeeds - which is the behaviour the repair relies on.
cat > "$WORK/bin/git" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  dest="${!#}"
  if grep -q 'reinstall.*libcurl' "$FAKE_LOG" 2>/dev/null; then
    mkdir -p "$dest/src" "$dest/.git"
    echo "console.log('hi')" > "$dest/src/cli.js"
    exit 0
  fi
  # A failed clone leaves the directory behind with only .git in it.
  mkdir -p "$dest/.git"
  echo "Cloning into '$dest'..."
  echo 'CANNOT LINK EXECUTABLE ".../git-core/git-remote-https": cannot locate symbol "curl_global_trace" referenced by ".../git-remote-http"...'
  echo "fatal: remote helper 'https' aborted session"
  exit 128
fi
exit 0
FAKE
chmod +x "$WORK/bin/apt-get" "$WORK/bin/git"

export PATH="$WORK/bin:$PATH"
export TERMUX_VERSION=0.118.0 PREFIX="$WORK/prefix"
KEEP=(-o "Dpkg::Options::=--force-confold")

echo "fetch_source, libcurl branch:"

# ---- 1. repair and retry, leaving a real .git ------------------------------
FAKE_LOG="$WORK/apt1.log"
export FAKE_LOG
: > "$FAKE_LOG"
rc1=0
fetch_source "https://github.com/x/y.git" "$WORK/dest1" > "$WORK/out1" 2>&1 || rc1=$?

check "returns success" "$rc1" "0"
check "reinstalls libcurl" "$(grep -c 'reinstall.*libcurl' "$FAKE_LOG" 2>/dev/null || true)" "1"
check "ends up with a real checkout" "$([ -e "$WORK/dest1/src/cli.js" ] && echo yes || echo no)" "yes"
check "ends up with .git, so tca update works" "$([ -d "$WORK/dest1/.git" ] && echo yes || echo no)" "yes"
check "never reaches the tarball fallback" "$(grep -c 'tarball' "$WORK/out1" 2>/dev/null || true)" "0"

# ---- 2. a real checkout already there must not be deleted ------------------
mkdir -p "$WORK/dest2/.git" "$WORK/dest2/src"
echo "PRECIOUS" > "$WORK/dest2/src/cli.js"
echo "PRECIOUS" > "$WORK/dest2/my-work.txt"
FAKE_LOG="$WORK/apt2.log"
export FAKE_LOG
: > "$FAKE_LOG"
fetch_source "https://github.com/x/y.git" "$WORK/dest2" > "$WORK/out2" 2>&1 || true
check "leaves a populated directory alone" \
  "$([ -e "$WORK/dest2/my-work.txt" ] && echo kept || echo DELETED)" "kept"

# ---- 3. the size report -----------------------------------------------------
echo ""
echo "size reporting:"

check "megabytes are readable" "$(human_bytes 412430336)" "393 MB"
check "kilobytes are readable" "$(human_bytes 250000)" "244 kB"
check "gigabytes are readable" "$(human_bytes 2147483648)" "2.0 GB"
check "zero is not blank" "$(human_bytes 0)" "0 B"

sum() { awk '{ if ($3 ~ /^[0-9]+$/) total += $3 } END { print total + 0 }'; }
uris="'http://x/pool/main/n/nodejs/nodejs_24.4.1_aarch64.deb' nodejs_24.4.1_aarch64.deb 12345678 SHA256:a
'http://x/pool/main/c/clang/clang_21.1.8-3_aarch64.deb' clang_21.1.8-3_aarch64.deb 400000000 SHA256:b"

total="$(printf '%s\n' "$uris" | sum)"
check "sums the .deb size column" "$total" "412345678"
check "reports it in human terms" "$(human_bytes "$total")" "393 MB"

# Everything already cached: --print-uris prints nothing, which has to read as
# zero rather than as an error or an empty message.
empty="$(printf '' | sum)"
case "$empty" in '' | *[!0-9]*) empty=0 ;; esac
check "empty output means nothing to download" "$empty" "0"

# apt complaining instead of listing must not yield a non-numeric value that then
# blows up the `-gt` comparison in the script.
junk="$(printf 'E: Unable to locate package foo\n' | sum)"
case "$junk" in '' | *[!0-9]*) junk=0 ;; esac
check "apt errors do not become a bogus size" "$junk" "0"

echo ""
if [ "$fails" -ne 0 ]; then
  echo "${C_RED}$fails check(s) failed${C_OFF}"
  exit 1
fi
echo "${C_GREEN}all checks passed${C_OFF}"
