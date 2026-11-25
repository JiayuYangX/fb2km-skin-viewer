#!/usr/bin/env bash
# Build the viewer, optionally installing it into a directory you name.
#
#   bash build.sh                      build into build/ only
#   bash build.sh /c/Tools             build, then copy to /c/Tools/fbsv.exe
#   bash build.sh D:/bin               any path works, forward or back slashes
#   bash build.sh --no-copy            same as giving no destination
#
# Works from any directory and picks up the MSYS2 toolchain by itself.

set -euo pipefail
cd "$(dirname "$0")"

usage() {
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

dest=""
for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        -n|--no-copy) dest="" ;;
        -*) echo "unknown option: $arg" >&2; usage; exit 2 ;;
        *) dest="$arg" ;;
    esac
done

# MSYS2 toolchains are not on PATH in a plain shell; put the newest first
for dir in /ucrt64/bin /mingw64/bin /clang64/bin; do
    [[ -d $dir ]] && PATH="$dir:$PATH"
done
export PATH

BIN=build/fbsv.exe
mkdir -p build

# git is not part of the MSYS2 environment by itself; the Windows install works
for g in "/c/Program Files/Git/cmd" "/c/Program Files (x86)/Git/cmd"; do
    [[ -x "$g/git.exe" ]] && PATH="$g:$PATH"
done
export PATH

# the version comes from the newest tag, with the number of commits since it, so
# the executable and its resource block never disagree
VER="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
[[ -z "$VER" && -f VERSION ]] && VER="$(tr -d '\r\n' < VERSION)"
[[ -z "$VER" ]] && VER="0.0.0"
AHEAD="$(git rev-list --count "$(git describe --tags --abbrev=0 2>/dev/null || echo HEAD)"..HEAD 2>/dev/null || echo 0)"
FULL="$VER"
[[ "$AHEAD" != "0" ]] && FULL="$VER+$AHEAD"
IFS=. read -r V_MAJOR V_MINOR V_PATCH <<< "$VER"
: "${V_MAJOR:=0}" "${V_MINOR:=0}" "${V_PATCH:=0}"

cat > build/version.rc.inc <<EOF
#define FBSV_VER_MAJOR $V_MAJOR
#define FBSV_VER_MINOR $V_MINOR
#define FBSV_VER_PATCH $V_PATCH
#define FBSV_VER_TEXT  "$FULL"
EOF
echo "  version $FULL"

echo "  resources"
windres page.rc -O coff -o build/page_res.o

echo "  compile"
g++ -std=c++20 -O2 -DTAGLIB_STATIC -static -o "$BIN" \
    -DFBSV_VERSION="\"$FULL\"" \
    viewer.cpp build/page_res.o \
    -lws2_32 -lshell32 -lole32 -luuid -lz -lwindowscodecs \
    /ucrt64/lib/libtag.a /ucrt64/lib/libz.a

if [[ -z "$dest" ]]; then
    echo "  built $BIN (not installed)"
    exit 0
fi

dest="${dest//\\//}"          # C:\Tools -> C:/Tools
mkdir -p "$dest"
cp "$BIN" "$dest/fbsv.exe"
echo "  installed $dest/fbsv.exe"
