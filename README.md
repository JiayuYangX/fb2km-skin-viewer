# foobar2000 mobile Skin Viewer

[English](README.md) | [简体中文](README.zh.md)

## Overview

A tool for previewing foobar2000 mobile skins. It is a single executable: run it
and it serves the skin over HTTP on `127.0.0.1`, then opens the preview page in
your browser.

The app's behaviour is reproduced as well as its rendering: how the playlist
advances, how a button responds when pressed, how labels and pictures are laid
out. A skin can be checked under close to real interaction.

## Usage

### Commands

```
fbsv.exe                          the folder it sits in, plus the built-in skins
fbsv.exe <folder>                 a skin folder
fbsv.exe <skin.fbskin>            a packaged skin
fbsv.exe <folder> <track>         with a track, filling the now playing screen
fbsv.exe <folder> <list.m3u8>     with a playlist
```

A folder, a `.fbskin` or a track can also be dropped onto `fbsv.exe`.

### Options

```
--no-open    serve only, no browser
--single     do not start while another copy is running
--top        keep the console above other windows
--debug      append ?debug to the address that is opened
```

### Interface

The page has four regions:

```
header     open skin folder | open package | skin | layout | status | language | theme
bar        open audio | open playlist | clear | prev play next stop | seek | clocks
           | order | repeat | stop after current
sidebar    the playlist, one row per track
preview    the skin itself, scaled to fit
```

- the header reports how many skins and layouts are loaded
- a row shows the title above the artist; clicking it plays that track
- with no track the seek bar keeps only its rail and both clocks read `--:--`,
  matching the skin's own idle arm
- the theme button cycles system, light and dark; the language switches between
  Chinese and English

### Drag and drop

| dropped | result |
|---|---|
| audio files, on a list row | inserted at the marker, in the order dropped |
| audio files, elsewhere | appended |
| `.fbskin` / `.zip` | opened as a skin package |
| a playlist | not accepted, use the open playlist button |
| anything else | not accepted |

A refusal, or a package that cannot be opened, shows one line at the bottom of
the page and changes nothing else.

## Playback control

### States

There are three states, and every way of loading audio ends in one of them:

| state | trigger | result |
|---|---|---|
| open | start-up, first file into an empty list, playlist into a stopped player | loaded at 0 and waiting, nothing plays |
| play | clicking a row, previous or next, automatic advance | switches and starts |
| keep | adding audio with a track loaded, reordering, removing, clearing | the playback state is unchanged |

- a file given at start-up is displayed only, not played
- adding a track during playback or pause neither restarts nor rewinds it
- opening a playlist replaces the list; a loaded track keeps sounding, and the
  player moves to the new first row after a stop
- clearing the list leaves the music playing; the next stop returns to the top
- without repeat, the last track stops when it ends

### Behaviour

The following were tuned against the device:

- long pressing play/pause (0.6 s) stops and rewinds
- a pressed button shows its `-hot` picture and acts on release
- previous and next move through the list and wrap at the ends
- one track, shuffle and repeat in the order dropdown follow the app's
  precedence; shuffle randomises previous, next and automatic advance
- stop after current stops when the track ends
- a skin's `*if` branches select on a track playing, a next track existing and
  the radio being on

### Formats

| container | tags | replaygain |
|---|---|---|
| FLAC | vorbis comments | `REPLAYGAIN_*` |
| MP3 | ID3v2.3 / 2.4 | `TXXX:replaygain_*` |
| M4A / MP4 | `ilst` atoms (`©nam`, `©ART`, `©alb`, `©day`, `----`) | `----:com.apple.iTunes:replaygain_*` |
| OGG / Opus / WAV / WavPack / AIFF / DSF | via TagLib | vorbis comments |

Embedded artwork is read from the same containers (FLAC `PICTURE`, MP3 `APIC`,
MP4 `covr`) and shown on the now playing screen; without artwork the skin's own
placeholder is used. Files carrying ReplayGain get a Web Audio gain stage.

## Skin rendering

### Folders and packages

A skin is a folder containing `skindef.txt`, or a `.fbskin` package. A package
is a zip whose entries are stored, not compressed; it is read into memory and
served from there, never written to disk. A single wrapper folder inside the
package is skipped.

Both can be open at once: open a folder, then a packaged subskin inside it, and
the list merges them without duplicates.

### Live reload

After a file in the skin folder changes, switching skins shows the new version
without a restart.

### Built-in skins

`White Skin` and `Black Skin` are always listed, white by default. Pictures a
skin lacks come from the built-in package.

### Layout files

`skindef.txt` lists the layouts, each pointing at a `.txt` describing elements.
If the preview is empty, check the skin and layout counts in the header first;
usually the skin lists no layout.

### Layout elements

- elements: `rect`, `line`, `label`, `image`, `art`, `pos`, `btn`
- branches: `*if` / `*elseif` / `*else` / `*end`
- button actions: `playnpause`, `skipback`, `skipnext`, `stop`, `play`,
  `pause`, `shuffle`, `repeat`, `stopaftercurrent`, `menu`, `onetrack`
- a `[position]` with knob/bar pictures draws them and drops the built-in line

### Text styles

- `[font-x]`, `[color-x]` and `[rgb-r,g,b]` colour the text that follows; a
  skindef font's own bold and italic take precedence; labels naming no font fall
  back to `genericfont`
- `[b]` uses weight 500 (Roboto Medium) and 700 is left to Bold, measured from
  device screenshots: 2.0 px of stroke, 3.0 px for Bold
- label type starts at 0.81 of the label box height and shrinks until the text
  fits; the figure comes from comparing rendered widths with a device screenshot
  at the same scale
- templates open a style run with `[b]`/`[i]` and close it with `[-b]`/`[-i]`
  anywhere in the label
- placeholders such as `%title%` are filled from the tags that were read; the
  data set is chosen by the label's own `[infosource-nextplaying]`
- the canvas is painted with the skin's `backgroundcol`, so a layout that does
  not cover it never shows the page colour; layout colour names are short forms
  of the skindef keys, `background` resolving to `backgroundcol`

### Title formatting

Title formatting is evaluated by `web/tf.js`, a common subset checked against
[titleformat-rs](https://github.com/ystreet/titleformat-rs) and the reference
document: around sixty functions, `[...]` conditional sections, `'` quoting,
`$puts`/`$get` and the truth rules. Anything it cannot parse falls back to the
sample text.

## Building

### Dependencies

A C++20 compiler is required. TagLib comes from MSYS2:

```sh
pacman -S mingw-w64-ucrt-x86_64-taglib
```

### Script

```sh
bash build.sh                 # build into build/ only
bash build.sh /c/Tools        # build, then copy to that folder
bash build.sh 'D:\bin'        # forward or back slashes both work
bash build.sh --help
```

The destination is an argument; nothing is hard coded. The script locates the
MSYS2 toolchain itself and runs from the repository root.

### Manual build

```sh
windres page.rc -O coff -o build/page_res.o
g++ -std=c++20 -O2 -DTAGLIB_STATIC -static -o build/fbsv.exe viewer.cpp build/page_res.o \
    -lws2_32 -lshell32 -lole32 -luuid -lz \
    /ucrt64/lib/libtag.a /ucrt64/lib/libz.a
```

### Resources

The page and its assets are compiled into the resource section:

| resource | file |
|---|---|
| `PAGE_HTML` | page.html |
| `APP_CSS` | app.css |
| `TF_JS` | tf.js |
| `APP_JS` | app.js |
| `ROBOTO_*` | the six woff2 subsets |
| `APP_ICON`, `APP_ICON_PNG`, `BRAND_PNG` | icon.ico, icon.png, brand.png |
| `DEFAULT_BLACK`, `DEFAULT_WHITE` | the built-in skin packages |

`load_web_assets()` fills a table from `WEB_ASSETS` through `read_resource()`
(`FindResource`/`LoadResource`); `serve_web_asset()` answers `/`, `/app.css`,
`/tf.js`, `/app.js` and `/fonts/*` from that table. Adding an asset takes three
changes: the file in `web/`, one `RCDATA` line in `page.rc`, and one row in
`WEB_ASSETS`.

## Files

```
viewer.cpp       server, tag readers, session state, argument handling
page.rc          resource list, icon and version block
app.manifest     execution level and DPI settings
web/page.html    page markup
web/app.css      styles
web/tf.js        title formatting evaluator
web/app.js       renderer: parsing, drawing, interaction, playback
web/fonts/       Roboto subsets and licence
assets/          icon, header mark, built-in skin packages
build/           build output, not tracked
build.sh         build script
```

`web/` is served; `assets/` is compiled in only.

## Notes

- the server listens on `127.0.0.1` only
- audio tags, artwork and gains come from TagLib; playback is the browser's job,
  so what plays depends on what it can decode
- playlists (`.m3u`, `.m3u8`, `.pls`) are read directly: one path per line,
  resolved against the list, `#` starting a comment
- `.fbskin` packages are read into memory; entries must be stored, not compressed
- title formatting is a subset; anything it cannot parse falls back to the sample
  text
- with a Chromium-based default browser the page is opened with
  `--autoplay-policy=no-user-gesture-required`, so the first play needs no click
- when the program runs elevated, a browser that is not may fail to reach the
  address; starting it normally avoids that
