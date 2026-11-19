#!/bin/sh
# Renders the Homebrew formula for a release from its SHA256SUMS:
#   packaging/homebrew/render.sh <version> <SHA256SUMS> <tap dir> [<archives base URL>]
# Writes <tap dir>/Formula/always-up-to-date.rb, as homebrew-tap keeps it. The archives come
# from the base URL, by default the release v<version> on GitHub; ci.yml passes a file:// URL
# to install the formula from the archives it just built.
set -eu
if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "usage: $0 <version> <SHA256SUMS> <tap dir> [<base URL>]" >&2
  exit 2
fi
version=$1 sums=$2 out=$3
# The version goes into sed replacements and the formula: nothing but a semver may.
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
  || { echo "invalid version: $version" >&2; exit 1; }
base=${4:-https://github.com/pixel-perfect-software/always-up-to-date/releases/download/v$version}
# Escaped for the sed replacement below, whose delimiter is |.
base_escaped=$(printf '%s' "$base" | sed 's/[\\&|]/\\&/g')
here=$(dirname "$0")
sha() {
  value=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$sums")
  [ -n "$value" ] || { echo "no checksum for $1 in $sums" >&2; exit 1; }
  echo "$value"
}
archive() { echo "always-up-to-date-$version-$1.tar.gz"; }
aarch64_darwin=$(sha "$(archive aarch64-apple-darwin)")
x86_64_darwin=$(sha "$(archive x86_64-apple-darwin)")
x86_64_linux=$(sha "$(archive x86_64-unknown-linux-gnu)")
aarch64_linux=$(sha "$(archive aarch64-unknown-linux-gnu)")
mkdir -p "$out/Formula"
sed -e "s/@VERSION@/$version/g" \
    -e "s|@BASE_URL@|$base_escaped|g" \
    -e "s/@SHA_AARCH64_APPLE_DARWIN@/$aarch64_darwin/" \
    -e "s/@SHA_X86_64_APPLE_DARWIN@/$x86_64_darwin/" \
    -e "s/@SHA_X86_64_UNKNOWN_LINUX_GNU@/$x86_64_linux/" \
    -e "s/@SHA_AARCH64_UNKNOWN_LINUX_GNU@/$aarch64_linux/" \
    "$here/always-up-to-date.rb.in" > "$out/Formula/always-up-to-date.rb"
