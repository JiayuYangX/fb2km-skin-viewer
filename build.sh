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

echo "  resources"
windres page.rc -O coff -o build/page_res.o

echo "  compile"
g++ -std=c++20 -O2 -DTAGLIB_STATIC -static -o "$BIN" \
    viewer.cpp build/page_res.o \
    -lws2_32 -lshell32 -lole32 -luuid -lz \
    /ucrt64/lib/libtag.a /ucrt64/lib/libz.a

if [[ -z "$dest" ]]; then
    echo "  built $BIN (not installed)"
    exit 0
fi

dest="${dest//\\//}"          # C:\Tools -> C:/Tools
mkdir -p "$dest"
cp "$BIN" "$dest/fbsv.exe"
echo "  installed $dest/fbsv.exe"
