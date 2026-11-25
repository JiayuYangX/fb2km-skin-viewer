// "9:16" -> 0.5625; anything without a colon is not a ratio and is skipped
function ratioOf(entry) {
  const m = String(entry).trim().match(/^([0-9.]+)\s*[:x/]\s*([0-9.]+)$/i);
  return m && +m[2] ? +m[1] / +m[2] : null;
}

// the skin's subskins are shaped for screens, so the list is matched by shape:
// the first entry that has a subskin within the tolerance wins
function preferredLayout(skin) {
  const names = Object.keys(skin.layouts);
  const tol = (hints.tolerance == null ? 15 : hints.tolerance) / 100;
  for (const entry of hints.layouts || []) {
    const target = ratioOf(entry);
    if (!target) continue;
    let best = null, bestErr = Infinity;
    for (const n of names) {
      const L = skin.layouts[n];
      if (!L || !L.w || !L.h) continue;
      const err = Math.abs(L.w / L.h - target) / target;
      if (err < bestErr) { bestErr = err; best = n; }
    }
    if (best && bestErr <= tol) return best;
  }
  return null;
}

function fillLayouts() {
  const skin = skins.get(state.skin);
  const sel = $("layout");
  sel.innerHTML = "";
  if (!skin) return;
  const names = Object.keys(skin.layouts);
  for (const name of names) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  }
  if (!skin.layouts[state.layout]) state.layout = names[0] || null;
  if (state.layout) sel.value = state.layout;
}


"use strict";

const $ = (id) => document.getElementById(id);
const stage = $("stage");

const state = {
  blobs: new Map(),          // object urls for every skin picture
  blobWait: new Map(),       // in-flight cover fetches
  blobTries: new Set(),      // urls already fetched for that cache
  skin: null, layout: null,
  hasAudio: false, stopped: false, playing: false,
  shuffle: false, repeatAll: false, onetrack: false,
  entries: [], seeking: false, fields: {}, nextFields: {}, stopAfter: false,
  pos: 0, cover: null, nextCover: null, index: 0, count: 0, fingerprint: "",
  buttons: [], posUI: null,
  pressedKey: null,          // the action of the key being held down right now
  artEl: null, artNextEl: null,   // the two [albumart] boxes of the current frame
  simStatus: false,          // draw the phone's status bar over the skin
  deviceFollow: true,        // the device is as big as the subskin unless told otherwise
  deviceW: 0, deviceH: 0,    // otherwise the size typed into the bottom bar
  statusBarH: 0,             // the bar height typed in, when not following the layout
};

const skins = new Map();          // name -> { def, layouts, base }
// fbsv.ini: which subskin ratios to prefer, most wanted first, and how far
// off a candidate may be before it counts as a different shape
let hints = { layouts: [], tolerance: 15 };

// ---------------------------------------------------------------- helpers --
function dec16(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  return new TextDecoder("utf-8").decode(b);
}




// classic title formatting has no sample data: a label shows the text it
// carries, and a field with no value formats to nothing
function plainText(content) {
  let t = content.replace(/\[[^\]]*\]/g, "").trim();
  const cut = t.indexOf("$");
  if (cut >= 0) t = t.slice(0, cut).trim();
  return t.slice(0, 48);
}

// A label is a skin template. [b]/[i] toggle style, [font-*]/[color-*]/[rgb-*]
// only affect colour here, [infosource-*] switches which track the rest of the
// line describes, the legacy [title]-style tags read one field directly, and
// everything else is title formatting, evaluated per run.
// the value tags the old format had before title formatting existed
const LEGACY = /^(title|artist|album|composer|albumartist|album artist|date|year|codec|codeclong|bitrate|channels|samplerate|filesize|tracknumber|length|currentposition|streamtitle|nexttitle|nextartist)$/;
const SKIN_TAG = /^(b|-b|i|-i|font-[\w-]+|color-[\w-]+|rgb-\d+-\d+-\d+|infosource-[\w-]+|system_time|system_time_seconds)$/;

function mediaDuration() {
  const a = $("audio");
  return a && isFinite(a.duration) && a.duration ? a.duration : 0;
}

function fieldSet(source) {
  const base = String(source || "").startsWith("next")
    ? (state.nextFields || {}) : (state.fields || {});
  const out = Object.assign({}, base);
  if (!out.length) out.length = mediaDuration() ? clock(mediaDuration()) : "";
  if (!out.playback_time) out.playback_time = clock(state.current || 0);
  if (!out.streamtitle) out.streamtitle = out.title || "";
  return out;
}

// a label keeps one line: it shrinks to a floor, then ellipsizes. The floor is
// relative to the size the skin declared, so it behaves the same on every canvas
// The device shrinks a label down to about 0.52 of its box height and cuts the
// text below that; the same measurement on our font puts the floor here.
const LABEL_FLOOR = 0.52 / 0.81;
const fitCanvas = document.createElement("canvas").getContext("2d");

// the text is measured on a canvas: once a label is ellipsized its laid-out
// width is the clipped one, so the DOM cannot tell us it is still too wide
// the artwork fills its box's width and keeps its own height; only when that
// height would overrun the box is it squeezed, never stretched. That needs the
// picture's own size, which arrives asynchronously, so it is cached here and the
// element is re-measured once it is known.
const artSizes = new Map();
function artSize(url, onKnown) {
  const known = artSizes.get(url);
  if (known) return known;
  const img = new Image();
  img.onload = () => {
    artSizes.set(url, { w: img.naturalWidth, h: img.naturalHeight });
    if (onKnown) onKnown();
  };
  img.src = url;
  return null;
}

// how light a skin's background is decides whether the bar reads dark or light
function luminanceOf(colour) {
  const text = String(colour || "").trim();
  let r = 0, g = 0, b = 0;
  const hex = /^#?([0-9a-f]{6})$/i.exec(text);
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else if (short) {
    r = parseInt(short[1] + short[1], 16);
    g = parseInt(short[2] + short[2], 16);
    b = parseInt(short[3] + short[3], 16);
  } else if (rgb) {
    const p = rgb[1].split(",").map((v) => parseFloat(v));
    r = p[0] || 0; g = p[1] || 0; b = p[2] || 0;
  } else {
    return 0;                       // unknown: treat as dark, so the bar goes light
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function wallClock() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function textWidth(el, size, text) {
  const cs = getComputedStyle(el);
  fitCanvas.font = cs.fontStyle + " " + cs.fontWeight + " " + size + "px " + cs.fontFamily;
  return fitCanvas.measureText(text === undefined ? (el.textContent || "") : text).width;
}

// the current frame is the only thing worth refitting
function refit() { if (state.lastBuf) fitLabels(state.lastBuf); }

function fitLabels(root) {
  for (const el of root.querySelectorAll(".lbl")) {
    const base = parseFloat(el.dataset.baseSize || "0");
    const box = el.clientWidth;
    if (!base || !box) continue;
    let size = base;
    for (let pass = 0; pass < 5; pass++) {
      const need = textWidth(el, size);
      if (need <= box * 0.98) break;
      const next = Math.max(base * LABEL_FLOOR, size * (box / need) * 0.98);
      if (Math.abs(next - size) < 0.05) { size = next; break; }
      size = next;
    }
    if (size < base - 0.01) el.style.fontSize = size + "px";
    // the device shrinks only so far and then cuts the text, marking the cut
    // with two dots; cutting flattens the label, which only happens to text that
    // cannot fit even at the smallest size
    const full = el.dataset.text || "";
    if (full) {
      el.style.textOverflow = "clip";   // the dots are ours, not the browser's
      if (textWidth(el, size, full) > box * 0.98) {
        let cut = full;
        while (cut.length > 1 && textWidth(el, size, cut + "..") > box * 0.98) cut = cut.slice(0, -1);
        el.textContent = cut + "..";
        // the canvas and the layout can disagree by a hair: let the box settle it
        while (cut.length > 1 && el.scrollWidth > el.clientWidth) {
          cut = cut.slice(0, -1);
          el.textContent = cut + "..";
        }
      }
    }
  }
}

function buildRuns(raw, def, source) {
  const frag = document.createDocumentFragment();
  let bold = false, italic = false;
  let src = String(source || "");
  const fonts = (def && def.fonts) || {};
  const colours = (def && def.colours) || {};
  let colour = null;                 // null: inherit the label's own colour
  const vars = {};
  let buf = "";
  let produced = false;

  let lastSpan = null, lastKey = "";
  const push = (text) => {
    if (text === undefined || text === null || text === "") return;
    // a tag that changes nothing ([-b] when already off, say) must not split the
    // line, otherwise a label with many tags becomes a pile of identical spans
    const key = (bold ? "b" : "") + (italic ? "i" : "") + (colour || "");
    if (lastSpan && key === lastKey) {
      lastSpan.textContent += String(text);
    } else {
      const span = document.createElement("span");
      span.textContent = text;
      if (bold) span.style.fontWeight = "500";
      if (italic) span.style.fontStyle = "italic";
      if (colour) span.style.color = colour;
      frag.appendChild(span);
      lastSpan = span;
      lastKey = key;
    }
    if (String(text).trim()) produced = true;
  };

  const flush = () => {
    if (!buf) return;
    const text = buf;
    buf = "";
    const fields = fieldSet(src);
    push(window.TF ? window.TF.format(text, fields, vars) : text);
  };

  // the pre-titleformatting tags, kept because skins still use them
  const legacy = (tag) => {
    const isNext = tag.startsWith("next");
    const fields = fieldSet(isNext ? "nextplaying" : src);
    switch (tag) {
      case "codeclong": return fields.codec_long || fields.codec || "";
      case "nextartist": return fields.artist || "";
      case "length": return fields.length || (mediaDuration() ? clock(mediaDuration()) : "--:--");
      case "currentposition": return clock(shownTime());
      case "streamtitle": return fields.streamtitle || "";
      case "nexttitle": return fields.title || "";
      case "albumartist": case "album artist": return fields["album artist"] || fields.artist || "";
      case "system_time": return new Date().toTimeString().slice(0, 5);
      case "system_time_seconds": return String(Math.floor(Date.now() / 1000));
      default: return fields[tag] || "";
    }
  };

  const text = String(raw || "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") {
      const end = text.indexOf("]", i);
      const tag = end > i ? text.slice(i + 1, end).toLowerCase() : "";
      if (tag && (SKIN_TAG.test(tag) || LEGACY.test(tag))) {
        flush();
        if (tag === "b") bold = true;
        else if (tag === "-b") bold = false;
        else if (tag === "i") italic = true;
        else if (tag === "-i") italic = false;
        else if (tag.startsWith("infosource-")) src = tag.slice("infosource-".length);
        else if (tag.startsWith("rgb-")) colour = "rgb(" + tag.slice(4).split("-").join(",") + ")";
        else if (tag.startsWith("color-")) {
          const named = resolveColour(tag.slice(6), def);
          if (named) colour = named;
        }
        else if (fontFor(tag, fonts)) {
          // a skindef font carries colour and style together, and the style it
          // declares replaces whatever was in force before it
          const font = fontFor(tag, fonts);
          colour = font.c || colour;
          bold = !!font.b;
          italic = !!font.i;
        }
        else push(legacy(tag));
        i = end;
        continue;
      }
    }
    buf += text[i];
  }
  flush();
  return produced ? frag : null;
}

function fontFor(name, fonts) {
  if (!fonts || !name || !name.startsWith("font-")) return null;
  if (fonts[name]) return fonts[name];                 // font-info stays as is
  const swapped = name.slice(5) + "font";              // font-artist -> artistfont
  return fonts[swapped] || null;
}

function labelStyle(content, def) {
  const fonts = (def && def.fonts) || {};
  // only the tags before any visible text set the label's own style; a tag in
  // the middle of the line belongs to the runs after it, not to the whole label
  let c = null, b = false, i = false;
  let rest = content;
  for (;;) {
    const m = /^\[(b|i|font-[\w\-]+|rgb-\d+-\d+-\d+|color-[\w\-]+)\]/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    const tok = m[1];
    const font = tok.startsWith("font-") ? fontFor(tok, fonts) : null;
    if (font) {
      c = font.c;
      b = b || font.b;
      i = i || font.i;
    } else if (tok.startsWith("rgb-")) {
      c = "rgb(" + tok.slice(4).split("-").join(",") + ")";
    } else if (tok.startsWith("color-")) {
      c = resolveColour(tok.slice(6), def) || c;
    } else if (tok === "b") b = true;
    else if (tok === "i") i = true;
  }
  return { c, b, i };
}

// both names are used in the wild: skindef.txt in format 2, skindef.skindef in
// skins built by the old designer
const DEF_NAMES = ["skindef.txt", "skindef.skindef"];

function parseSkindef(text) {
  const colours = {}, fonts = {}, meta = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([\w\-]+): (.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (/^\d+,\d+,\d+(;\w+)?$/.test(value)) {
      const [body, style = ""] = value.split(";");
      colours[key] = "rgb(" + body + ")";
      fonts[key] = { c: colours[key], b: /bold/.test(style), i: /italic/.test(style) };
    } else {
      meta[key] = value;          // name, author, version, skin-format…
    }
  }
  return { colours, fonts, ...meta };
}

// parameter lines may carry a trailing comment: "245,245,245 //light"
function stripComment(value) {
  return String(value == null ? "" : value).replace(/\s*\/\/.*$/, "").trim();
}

function resolveColour(value, def) {
  const v = stripComment(value);
  for (const key of [v, v + "col", v + "font"]) {
    if (def.colours[key]) return def.colours[key];
  }
  if (/^\d+,\d+,\d+$/.test(v)) return "rgb(" + v + ")";
  return null;
}

// ------------------------------------------------------------------ parser --
// mode "playing" takes the first arm of a conditional, "other" the else arm;
// radio blocks are always skipped because we preview a local track.
// the player's volume, 0..1; nothing in the interface changes it yet, so this is
// the audio element's own value
// Two numbers make the loudness: the one the volume bar shows, which is what a
// phone's system volume would be, and a replaygain factor that only ever scales
// playback. The bar shows the first, the speakers get the product.
function volumeFraction() {
  const v = Number.isFinite(state.volume) ? state.volume : 1;
  return Math.max(0, Math.min(1, v));
}

function applyVolume() {
  const audio = $("audio");
  if (!audio) return;
  const rg = Number.isFinite(state.rgFactor) ? state.rgFactor : 1;
  audio.volume = Math.max(0, Math.min(1, volumeFraction() * rg));
}

// dragging a volume bar only repaints the bars, like a seek drag repaints the bar
function setVolume(ratio) {
  state.volume = Math.min(1, Math.max(0, ratio));
  applyVolume();
  for (const bar of state.volumeBars || []) {
    bar.played.style.width = (state.volume * 100) + "%";
    if (bar.knob) bar.knob.style.left = Math.round(state.volume * bar.travel) + "px";
  }
}

function parseArm(lines, def, mode, overrides) {
  const els = [];
  const branch = [];
  let i = 0;

  // what the viewer pretends to be: a local track is playing, a next entry
  // always exists (in a one track list the next track is that same track),
  // and radio never plays here
  const env = { playing: mode === "playing", next: mode === "playing", radio: false };
  if (overrides) Object.assign(env, overrides);
  const evalCond = (expr) => {
    let text = (expr || "").trim().toLowerCase();
    let negate = false;
    while (text.startsWith("not ")) { negate = !negate; text = text.slice(4).trim(); }
    const value = !!env[text.split(" ")[0]];
    return negate ? !value : value;
  };

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith("//")) { i++; continue; }
    if (line.startsWith("*if")) {
      const draw = evalCond(line.slice(3));
      branch.push({ draw, taken: draw });
      i++; continue;
    }
    if (line.startsWith("*elseif")) {
      const b = branch[branch.length - 1];
      if (b) {
        b.draw = !b.taken && evalCond(line.slice(7));
        b.taken = b.taken || b.draw;
      }
      i++; continue;
    }
    if (line === "*else") {
      const b = branch[branch.length - 1];
      if (b) { b.draw = !b.taken; b.taken = true; }
      i++; continue;
    }
    if (line === "*end") { if (branch.length) branch.pop(); i++; continue; }
    if (branch.some((b) => !b.draw)) { i++; continue; }

    // Every element is read by its own fixed line count, and one that does not
    // carry what the format asks for is dropped rather than drawn in part - the
    // device leaves an empty box for a button with missing pictures.
    const box = (v) => {
      const parts = stripComment(v).split(",").map(Number);
      return parts.length === 4 && parts.every((n) => Number.isFinite(n)) ? parts : null;
    };
    if (line === "[rectangle]") {
      const c = resolveColour(lines[i + 1], def);
      const b = box(lines[i + 2]);
      if (c && b) els.push({ t: "rect", x: b[0], y: b[1], w: b[2], h: b[3], c });
      i += 3; continue;
    }
    if (line === "[label]") {
      const b = box(lines[i + 1]);
      const align = (lines[i + 2] || "").split(",")[0].trim();
      const content = lines[i + 3] || "";
      if (b) {
        const st = labelStyle(content, def);
        const src = /\[infosource-([\w-]+)\]/.exec(content);
        els.push({ t: "label", x: b[0], y: b[1], w: b[2], h: b[3], align, c: st.c || null,
                   b: st.b, i: st.i, raw: content, source: src ? src[1] : "" });
      }
      i += 4; continue;
    }
    if (line === "[image]") {
      const b = box(lines[i + 2]);
      const file = (lines[i + 1] || "").trim();
      if (b && /\.(png|jpe?g|webp)$/i.test(file)) {
        els.push({ t: "image", x: b[0], y: b[1], w: b[2], h: b[3], src: file });
      }
      i += 3; continue;
    }
    if (line === "[albumart]") {
      const b = box(lines[i + 1]);
      const which = (lines[i + 2] || "").trim().toLowerCase();
      if (b && (which === "main" || which === "next")) {
        els.push({ t: "art", x: b[0], y: b[1], w: b[2], h: b[3], next: which === "next" });
      } else if (b && (which === "mainback" || which === "mainmirrored")) {
        if (!def.oldFormat) {
          // a format 2 skin: the 2.x app drops this type, so the preview does too
          (state.unknown || (state.unknown = new Set())).add("[albumart] " + which);
          i += 3;
          continue;
        }
        // The old designer's two extra types. The 2.x app drops both, so these are
        // only here for skins written against 1.x: mainback covers its box, and
        // mainmirrored is the picture squashed into a strip and flipped over.
        els.push({ t: "art", x: b[0], y: b[1], w: b[2], h: b[3], next: false,
                   mirror: which === "mainmirrored",
                   backdrop: which === "mainback" });
      }
      i += 3; continue;
    }
    if (line === "[position]") {
      const b = box(lines[i + 1]);
      const png = (v) => (/\.(png|jpe?g|webp)$/i.test(stripComment(v)) ? stripComment(v) : "");
      const knob = png(lines[i + 2]), bar = png(lines[i + 3]), barHot = png(lines[i + 4]);
      // a probe row by row: only the inactive picture is required; without it the
      // phone draws nothing, while a junk knob or active picture is simply skipped
      if (b && bar) {
        els.push({ t: "pos", x: b[0], y: b[1], w: b[2], h: b[3],
                   knob, bar, barHot: barHot || bar });
      }
      i += 5; continue;
    }
    if (line === "[volume]") {
      // the old designer's volume bar: a marker, a back image and the part already
      // set, drawn exactly like a seek bar but where the marker sits follows the
      // player's volume rather than the track's progress
      const b = box(lines[i + 1]);
      const png = (v) => (/\.(png|jpe?g|webp)$/i.test(stripComment(v)) ? stripComment(v) : "");
      const knob = png(lines[i + 2]), bar = png(lines[i + 3]), set = png(lines[i + 4]);
      if (b && bar) {
        els.push({ t: "pos", x: b[0], y: b[1], w: b[2], h: b[3],
                   knob, bar, barHot: set || bar, volume: true });
      }
      i += 5; continue;
    }
    if (line === "[button]") {
      const b = box(lines[i + 1]);
      const png = (v) => (/\.(png|jpe?g|webp)$/i.test(stripComment(v)) ? stripComment(v) : "");
      // a button is seven lines: box, action and four pictures
      const src = png(lines[i + 3]), hot = png(lines[i + 4]);
      const src2 = png(lines[i + 5]), hot2 = png(lines[i + 6]);
      // the same probe: only the resting picture is required, so a button whose
      // other three are junk still draws; the missing ones fall back to it
      if (b && src) {
        els.push({ t: "btn", x: b[0], y: b[1], w: b[2], h: b[3],
                   action: (lines[i + 2] || "").trim(),
                   src, hot: hot || src, src2: src2 || src, hot2: hot2 || hot || src });
      }
      i += 7; continue;
    }
    if (line === "[frame]") {
      // the old designer's hollow rectangle: one pixel of colour around the box
      const c = resolveColour(lines[i + 1], def);
      const b = box(lines[i + 2]);
      if (c && b) els.push({ t: "frame", x: b[0], y: b[1], w: b[2], h: b[3], c });
      i += 3; continue;
    }
    if (line === "[line]") {
      const c = resolveColour(lines[i + 1], def);
      const parts = String(lines[i + 2] || "").split(",").map(Number);
      if (c && parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [x1, y1, x2, y2] = parts;
        els.push({ t: "line", x: x1, y: y1, w: x2 - x1, h: Math.max(1, y2 - y1), c });
      }
      i += 3; continue;
    }
    // only a bare [name] counts as an element; a label line such as
    // "[rgb-175-175-175]-10" is text left behind by a commented-out block
    if (/^\[[a-z]+\]$/i.test(line.trim())) {
      // an element this viewer does not know: skip the whole block, guessing how
      // many lines it owns, and tell the console rather than the screen
      const name = line.trim();
      (state.unknown || (state.unknown = new Set())).add(name);
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("[")) i++;
      continue;
    }
    i++;
  }
  return els;
}

function parseLayout(text, def, size) {
  const lines = text.split(/\r?\n/);
  let W = size && size.w ? size.w : 0;
  let H = size && size.h ? size.h : 0;
  if (!W || !H) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "[rectangle]") {
        const c = lines[i + 2].split(",");
        W = +c[2]; H = +c[3];
        break;
      }
    }
  }
  return {
    w: W, h: H,
    els: parseArm(lines, def, "playing"),
    // the same arm as drawn when there is no next track: `*if next` blocks drop out
    elsNoNext: parseArm(lines, def, "playing", { next: false }),
    elsAlt: parseArm(lines, def, "other"),
  };
}

// ------------------------------------------------------------------ render --
// every picture is also kept as an object URL in memory: once fetched, a button
// can switch art long after the server is gone and the browser's http cache has
// been evicted, because nothing has to be requested again
function blobURL(skin, file) {
  if (!skin || !skin.base || !file) return null;
  const key = skin.base + file;
  return (state.blobs && state.blobs.get(key)) || null;
}

// artwork is cached the same way: a long jump back should not wait for a fetch
// fetch the covers on either side so a jump in any direction has its art ready
function prefetchNeighbours() {
  const ids = state.entries.map((e) => e.id);
  const at = ids.indexOf(state.playingId);
  for (const step of [-1, 1]) {
    const id = ids[at + step];
    if (id != null) coverBlob("/cover?play=" + id);
  }
}

// returns a decoded blob or null: drawing a plain http url would blank the
// picture while the browser fetches it, so the caller keeps the previous art
function coverBlob(url) {
  if (!url) return null;
  const key = "cover " + url;
  const stored = state.blobs.get(key);
  if (stored) return stored;
  if (!state.blobWait.has(key)) {
    const wait = fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return;
        const src = URL.createObjectURL(b);
        state.blobs.set(key, src);
        // the picture only has to reach a box that is showing it; a cover nothing
        // on screen uses waits in the cache instead of redrawing the stage, which
        // used to replace every key while the list was being prefetched
        const box = state.cover === url ? state.artEl
                  : state.nextCover === url ? state.artNextEl : null;
        if (box) box.style.backgroundImage = 'url("' + src + '")';
      })
      .catch(() => {});
    state.blobWait.set(key, wait);
  }
  return null;
}

// the app has every cover ready before you touch the list, and so do we: one at
// a time, so a long playlist does not open fifty connections at once
async function prefetchCovers() {
  for (const entry of state.entries) {
    if (!entry || entry.id == null) continue;
    const url = "/cover?play=" + entry.id;
    coverBlob(url);
    const wait = state.blobWait.get("cover " + url);
    if (wait) await wait;
  }
}

function imgURL(skin, file) {
  if (!skin || !skin.base || !file) return null;
  const stored = blobURL(skin, file);
  if (stored) return stored;
  const url = skin.base + file + (state.fingerprint ? "?v=" + state.fingerprint : "");
  // anything the layout asks for that the warm list missed is fetched here, so a
  // later state change can still draw it after the server is gone
  if (state.skinsReady && !state.blobTries.has(url)) {
    state.blobTries.add(url);
    fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return;
        state.blobs.set(skin.base + file, URL.createObjectURL(b));
        if (state.skinsReady) render();
      })
      .catch(() => {});
  }
  return null;
}

function buttonPair(e, skin) {
  const second =
    e.action === "playnpause" ? state.playing :
    e.action === "shuffle" ? state.shuffle :
    e.action === "repeat" ? state.repeatAll :
    e.action === "stopaftercurrent" ? !!state.stopAfter :
    e.action === "onetrack" ? state.onetrack : false;
  const normal = second && e.src2 ? e.src2 : e.src;
  const hot = second && e.hot2 ? e.hot2 : e.hot;
  return { normal: imgURL(skin, normal), hot: hot ? imgURL(skin, hot) : null };
}

function refreshButtons() {
  syncChrome();
  for (const b of state.buttons) {
    b.pair = buttonPair(b.e, b.skin);
    // a key that is being held keeps its pressed picture: the render that
    // rebuilt it must not quietly show the resting one
    const held = state.pressedKey === b.e.action && b.pair.hot;
    const src = held ? b.pair.hot : b.pair.normal;
    // a key the skin gives no picture for stays invisible; asking the browser to
    // load nothing would leave its broken-image frame on screen instead
    if (src) {
      b.el.src = src;
      b.el.style.visibility = "";
    } else {
      b.el.removeAttribute("src");
      b.el.style.visibility = "hidden";
    }
  }
}

// one position for both bars: the skin's [position] and the toolbar slider
function shownTime() {
  // exactly what the bars show: one source for the picture and the digits
  const a = $("audio");
  const d = a && isFinite(a.duration) ? a.duration : 0;
  return state.pos * d;
}

function paintPosition() {
  const pct = (state.pos * 100).toFixed(2);
  const ui = state.posUI;
  if (ui) {
    if (ui.played) ui.played.style.width = pct + "%";
    // the marker travels the free distance, not past the ends of the strip
    if (ui.knob) ui.knob.style.left = Math.round(state.pos * ui.travel) + "px";
  }
  const seek = $("seek");
  if (seek) {
    seek.style.setProperty("--p", pct + "%");
    // always mirror the position: during a drag this is the same value the
    // browser already has, and dragging the skin bar must move this thumb too
    seek.value = String(Math.round(state.pos * 1000));
  }
  refreshElapsed();
}

function setPos(ratio) {
  state.pos = Math.min(1, Math.max(0, ratio));
  paintPosition();
}


function render() {
  // a volume drag owns the bars while it runs; rebuilding the stage underneath
  // the pointer would end the gesture
  if (state.draggingVolume) return;
  const skin = skins.get(state.skin);
  if (!skin) return;
  const L = skin.layouts[state.layout];
  if (!L) return;

  const audio = $("audio");
  // opening a new source reports paused for a moment; that is not a user pause
  if (audio && !state.switching) state.playing = !audio.paused;
  const showTrack = trackLoaded();
  const hasNext = showTrack && L.w && autoNext() >= 0;
  const els = showTrack
    ? (hasNext ? L.els : (L.elsNoNext.length ? L.elsNoNext : L.els))
    : (L.elsAlt.length ? L.elsAlt : L.els);

  state.volumeBars = [];
  const box = $("wrap");
  const availW = Math.max(0, box.clientWidth - 32);
  const availH = Math.max(0, box.clientHeight - 32);
  if (availW < 80 || availH < 80) { requestAnimationFrame(render); return; }
  // The canvas is the device screen; the skin is drawn into what the status bar
  // leaves and is stretched over it, exactly as the phone does. The device is
  // the subskin's own size unless the bottom bar says otherwise.
  const skinW = L.w, skinH = L.h;
  const follow = state.deviceFollow;
  const deviceW = follow ? skinW : Math.max(120, state.deviceW || skinW);
  const deviceH = follow ? skinH : Math.max(120, state.deviceH || skinH);

  const k = Math.min(availW / deviceW, availH / deviceH);
  const sim = state.simStatus;
  // the bar keeps to the short side's fifteenth unless the field beside it names a
  // height; following the layout leaves it on that rule, like the size fields
  // like the size fields, this is a plain number once it has been set; only while
  // it is still unset does the layout suggest one (the short side's fifteenth)
  const autoStatus = Math.max(8, Math.round(Math.min(deviceW, deviceH) / 15));
  const statusDev = sim ? (state.statusBarH > 0 ? state.statusBarH : autoStatus) : 0;
  // The skin is stretched over the screen in both directions: the phone maps the
  // layout's width onto the screen's width and its height onto the height left
  // under the status bar, whatever that does to the proportions
  const sx = deviceW / skinW;
  const sy = Math.max(1, deviceH - statusDev) / skinH;
  const kx = sx * k;
  const ky = sy * k;
  const offY = statusDev * k;
  const skinPxW = skinW * kx;
  const skinPxH = skinH * ky;

  stage.style.width = (deviceW * k) + "px";
  stage.style.height = (deviceH * k) + "px";
  // the canvas is painted with the skin's own background colour; without one the
  // device shows black, not the colour of whatever sits behind the view
  const base = (skin.def.fonts.backgroundcol || {}).c;
  // what the skin does not cover stays the device's own empty space: black
  stage.style.background = "#000";
  // build into a hidden layer and swap when it is painted: clearing the stage
  // first leaves one frame with nothing in it, which reads as a flash
  // the refs below point into the frame being built, so they start empty
  state.artEl = null;
  state.artNextEl = null;

  const buf = document.createElement("div");
  buf.className = "buf";
  // the buffer is the skin itself, sitting below the status bar; the device's
  // leftover space around it keeps the stage colour
  buf.style.cssText = "position:absolute;left:0;top:" + offY + "px;width:" + skinPxW +
    "px;height:" + skinPxH + "px;background:" + (base || "#000") +
    ";opacity:0;pointer-events:none;";
  const token = (state.renderToken = (state.renderToken || 0) + 1);
  state.buttons = [];
  state.posUI = null;
  $("status").textContent = L.w + "x" + L.h + "  " + els.length + " elements";


  for (const e of els) {
    let el = null;
    const place = (node) => {
      node.style.left = e.x * kx + "px";
      // the buffer itself already starts below the status bar, so no offset here
      node.style.top = (e.y * ky) + "px";
      node.style.width = e.w * kx + "px";
      node.style.height = e.h * ky + "px";
      buf.appendChild(node);
    };

    if (e.t === "frame") {
      el = document.createElement("div");
      el.style.background = "transparent";
      el.style.border = Math.max(1, Math.round(kx)) + "px solid " + e.c;
      el.style.boxSizing = "border-box";
    } else if (e.t === "rect" || e.t === "line") {
      el = document.createElement("div");
      el.style.background = e.c;

    } else if (e.t === "label") {
      // the two clock labels belong to the track: with nothing loaded the device
      // leaves them out
      if (!showTrack && /\[(currentposition|length)\]/i.test(e.raw || "")) continue;
      el = document.createElement("div");
      el.className = "lbl";
      // labels without a [font-x] take the skin's generic font colour, which is
      // what makes the light theme readable instead of white on white
      const generic = (skin.def.fonts.genericfont || {}).c;
      el.style.color = e.c || generic || null;
      el.style.fontWeight = e.b ? "500" : "400";
      el.style.fontStyle = e.i ? "italic" : "normal";

      if (String(e.raw).includes("currentposition")) {
        state.timeNode = { el, raw: e.raw, def: skin.def, source: e.source };
      }
      const runs = buildRuns(e.raw, skin.def, e.source);
      if (runs) {
        // the runs carry their own weight and slant, so the box goes regular
        el.style.fontWeight = "400";
        el.style.fontStyle = "normal";
        el.appendChild(runs);
      } else {
        el.textContent = plainText(e.raw || "");
      }
      el.dataset.text = el.textContent || "";
      // Font size as a fraction of the label box height, calibrated against a
      // device screenshot of the Eclipse skin: 0.85 was 5% too wide, 0.81 lands
      // within half a percent of the device's line widths.
      // no absolute minimum: it would break the ratio whenever the page is
      // zoomed out, because the stage shrinks while 7px does not
      const baseFont = Math.max(0.5, e.h * ky * 0.81);
      el.style.fontSize = baseFont + "px";
      el.dataset.baseSize = String(baseFont);
      el.style.lineHeight = e.h * ky + "px";
      el.style.textAlign =
        e.align === "right" ? "right" : e.align === "centered" ? "center" : "left";
      const raw = String(e.raw || "");
      // the placeholders themselves say what a label shows
      if (raw.includes("[currentposition]")) el.dataset.elapsed = "1";
      if (raw.includes("[length]")) el.dataset.total = "1";

    } else if (e.t === "art") {
      // the artwork is the background of a div, not an <img>: a picture that
      // fails to load then leaves an empty square rather than the browser's
      // broken-image frame. An <img> paints perfectly well; the flicker this
      // used to show was the frame swap, which render() now holds back.
      el = document.createElement("div");
      // the old mirrored type is the same picture turned upside down, which is
      // all the 1.6.9 app does with it
      if (e.mirror) el.style.transform = "scaleY(-1)";
      // the placeholder is whatever the skin names and nothing else: a skin that
      // names none shows an empty square, which is what the device does
      const fallback = imgURL(skin, skin.def.defaultart);
      // stopped or empty: no cover and no remembered one, only the skin's
      // placeholder, which is what the device shows on its idle arm
      const wanted = showTrack
        ? (e.next ? (state.nextCover || state.cover) : state.cover)
        : null;
      const ready = coverBlob(wanted);
      const previous = showTrack ? (e.next ? state.lastNextArt : state.lastArt) : null;
      // with nothing on screen yet the url is still better than the default art
      const src = ready || previous || wanted;
      if (ready) { if (e.next) state.lastNextArt = ready; else state.lastArt = ready; }
      // a track without artwork leaves the space empty, but with no track at all
      // the skin's own placeholder is what the device shows
      const none = !wanted && showTrack;
      const shown = none ? null : (src || fallback);
      if (shown) {
        el.style.backgroundImage = 'url("' + shown + '")';
        el.style.backgroundPosition = "center";
        el.style.backgroundRepeat = "no-repeat";
        // the decision is made in the device's own pixels, not the display's:
        // the phone floors the box height there, and a scaled-down preview must
        // not change the answer
        const boxW = e.w * sx, boxH = e.h * sy;
        // width first, the picture's own height after; squeeze only if it would
        // overflow the box, which is what the phone does with a frame too short
        const fitArt = (url) => {
          const size = artSize(url, () => {
            // the picture's size arrives after the element is on screen, and this
            // call's return value has nowhere to go: apply it here
            if (el.style.backgroundImage.indexOf(url) >= 0) {
              el.style.backgroundSize = fitArt(url);
            }
          });
          if (!size) return "100% auto";                 // unknown yet: keep the shape
          const scaledH = size.h * (boxW / size.w);
          if (scaledH <= boxH + 0.5) return "100% auto";  // shorter than the box: keep the shape
          // A box within five percent of the picture's shape is squashed to fill
          // it; a box further off keeps the picture's shape and is centred. The
          // phone's own border sits somewhere between 4.6 and 5 percent and its
          // exact rule is not pinned down; five percent is the simpler choice
          // until the app's own code has been read. It floors the box height
          // before comparing (a 457.92 box behaves like 457, while 458 fills).
          return Math.floor(boxH) / scaledH >= 0.95 ? "100% 100%" : "contain";
        };
        // The two old types are measured against the 1.6.9 app: mainback zooms in
        // until the box is covered (no desaturation and no dimming, whatever the
        // old notes claim), and mainmirrored squashes the whole picture into its
        // strip so the result reads as a reflection. Plain main keeps its shape,
        // like every other picture in a layout.
        if (e.mirror) el.style.backgroundSize = "100% 100%";
        else if (e.backdrop) el.style.backgroundSize = "cover";
        else el.style.backgroundSize = fitArt(shown);
      }
      if (e.next) state.artNextEl = el; else state.artEl = el;

    } else if (e.t === "pos") {
        el = document.createElement("div");
        const mid = e.h / 2;

        // a skin that ships its own slider pictures gets those, and a picture it
        // lacks is simply not drawn: the device takes nothing from the built-in
        // skin for this element
        const posImage = (file) => (!file ? null : imgURL(skin, file));
        const paint = (node, file, size) => {
          const url = posImage(file);
          if (!url) return false;
          node.style.backgroundImage = 'url("' + url + '")';
          node.style.backgroundSize = size;
          node.style.backgroundRepeat = "no-repeat";
          node.style.backgroundPosition = "center";
          return true;
        };

        const track = document.createElement("div");
        const hasBar = paint(track, e.bar, "100% 100%");
        if (!hasBar) {
          el.style.pointerEvents = "auto";
          el.style.cursor = "pointer";
          el.style.touchAction = "none";
          wireSeek(el);
        } else {
          track.style.position = "absolute";
          track.style.left = "0";
          track.style.right = "0";
          track.style.top = "0";
          track.style.height = (e.h * ky) + "px";
          el.appendChild(track);

          // a volume bar has something to show with or without a track; a seek bar
          // only once the player holds one
          if (showTrack || e.volume) {
            const played = document.createElement("div");
            played.style.position = "absolute";
            played.style.left = "0";
            played.style.top = "0";
            played.style.height = (e.h * ky) + "px";
            // a volume bar reads the player's own volume, a seek bar the track's
            // progress
            const frac = e.volume ? volumeFraction() : state.pos;
            played.style.width = (frac * 100) + "%";
            // the played piece is the same picture clipped to the elapsed width,
            // not the whole picture squeezed into it (that looked faint)
            played.style.backgroundImage = 'url("' + posImage(e.barHot || e.bar) + '")';
            played.style.backgroundSize = (e.w * kx) + "px " + (e.h * ky) + "px";
            played.style.backgroundPosition = "left center";
            played.style.backgroundRepeat = "no-repeat";
            el.appendChild(played);

            const knob = document.createElement("div");
            // The phone draws the marker at the picture's own pixel width scaled by
            // kx, and at the bar's full height: a 200x200 marker in a 1000x90 bar
            // came out 200 wide and 90 tall, and the default skin's 140x140 one
            // came out 67 by 84 on a 1080 wide screen.
            const knobURL = posImage(e.knob);
            const knobH = e.knob ? e.h * ky : 0;
            const knobW = e.knob ? (artSize(knobURL) ? artSize(knobURL).w * kx : knobH) : 0;
            const refit = () => {
              const size = artSize(knobURL);
              if (!size) return;
              const w = size.w * kx;
              knob.style.width = w + "px";
              if (!e.volume && state.posUI && state.posUI.knob === knob) {
                state.posUI.d = w;
                state.posUI.travel = Math.max(0, (e.w * kx) - w);
                knob.style.left = Math.round(state.pos * state.posUI.travel) + "px";
              }
            };
            if (!artSize(knobURL)) artSize(knobURL, refit);
            if (paint(knob, e.knob, "100% 100%")) {
              // it slides over the distance the strip leaves free, so it never
              // hangs past either end of it
              const travel = Math.max(0, (e.w * kx) - knobW);
              knob.style.position = "absolute";
              knob.style.top = ((mid * ky) - (knobH / 2)) + "px";
              knob.style.left = Math.round((e.volume ? volumeFraction() : state.pos) * travel) + "px";
              knob.style.width = knobW + "px";
              knob.style.height = knobH + "px";
              el.appendChild(knob);
              if (e.volume) {
                state.volumeBars.push({ played, knob, travel });
              } else {
                state.posUI = { played, knob, d: knobW, travel };
              }
            } else if (!e.volume) {
              state.posUI = { played, knob: null, d: 0, travel: 0 };
            }

            el.style.pointerEvents = "auto";
            el.style.cursor = "pointer";
            el.style.touchAction = "none";
            if (e.volume) wireVolume(el); else wireSeek(el);
          }
        }

      } else if (e.t === "btn" || e.t === "image") {
      // the menu key is drawn like the device shows it; pressing it does nothing
      el = document.createElement("img");
      el.draggable = false;                                 // no drag ghosts
      el.style.objectFit = "fill";                          // skin pictures stretch to the rect
      // a picture that cannot be fetched must not turn into a broken icon: keep
      // the last one that worked, or hide the element entirely
      el.addEventListener("load", () => { if (el.getAttribute("src")) el.dataset.prev = el.getAttribute("src"); });
      el.addEventListener("error", () => {
        // a picture the skin lacks is not drawn; only the skindef images are
        // taken from the built-in skin, never the layout ones
        const prev = el.dataset.prev;
        if (prev && el.getAttribute("src") !== prev) el.src = prev;
        else el.style.visibility = "hidden";
      });
      if (e.t === "btn") {
        el.style.cursor = "pointer";
        el.style.touchAction = "none";
        wireButton(el, e, skin);
      } else {
        const url = imgURL(skin, e.src);
        if (url) el.src = url; else continue;
      }
    }

    if (el) place(el);
  }
  if (sim) {
    const fg = luminanceOf(base) > 0.55 ? "#141414" : "#ffffff";
    const bar = document.createElement("div");
    bar.className = "simbar";
    // the buffer starts below the bar, so the bar is placed back at the top of
    // the screen instead of at the top of the skin
    bar.style.top = (-offY) + "px";
    bar.style.height = (statusDev * k) + "px";
    bar.style.background = base || "#000";
    bar.style.color = fg;
    bar.style.padding = "0 " + Math.round(statusDev * k * 0.52) + "px";
    const clock = document.createElement("div");
    clock.id = "simclock";
    clock.textContent = wallClock();
    clock.style.fontSize = Math.round(statusDev * k * 0.52) + "px";
    bar.appendChild(clock);
    const icons = document.createElement("div");
    icons.className = "simicons";
    icons.style.gap = Math.round(statusDev * k * 0.3) + "px";
    icons.style.height = Math.round(statusDev * k * 0.56) + "px";
    icons.innerHTML = SIM_WIFI + SIM_BATTERY;
    bar.appendChild(icons);
    buf.appendChild(bar);
  }

  // the bottom bar mirrors what this render actually used
  const sh = $("status-h");
  if (sh) {
    // the field is owned by the follow switch, not by the bar's own switch: while
    // following, the height is worked out, and the bar being off only means it is
    // not drawn
    if (document.activeElement !== sh) {
      sh.value = String(follow ? autoStatus : (state.statusBarH || autoStatus));
    }
    sh.disabled = follow;
  }
  const bw = $("device-w"), bh = $("device-h"), bf = $("device-follow");
  if (bw && bh) {
    bw.value = String(follow ? skinW : deviceW);
    bh.value = String(follow ? skinH : deviceH);
    bw.disabled = bh.disabled = follow;
  }
  if (bf) bf.checked = follow;

  refreshButtons();
  updateClocks(buf);

  stage.appendChild(buf);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
    if (state.renderToken !== token) { buf.remove(); return; }   // superseded
    buf.style.opacity = "1";
    buf.style.pointerEvents = "auto";
    state.lastBuf = buf;
    fitLabels(buf);
    // the first pass may still see the fallback font: one more frame settles it
    requestAnimationFrame(() => { if (state.lastBuf === buf) fitLabels(buf); });
    [...stage.children].forEach((c) => { if (c !== buf) c.remove(); });
    });
  });
}

// the preview clock keeps time even when nothing else changes
setInterval(() => {
  const c = document.getElementById("simclock");
  if (c) c.textContent = wallClock();
}, 10000);

// ------------------------------------------------------------- interaction --
async function stopPlayback() {
  const a = $("audio");
  state.playing = false;
  state.stopped = true;          // long pressing play closes the file
  state.pos = 0;
  if (a) { a.pause(); a.currentTime = 0; }
  render();
  syncProgress();

  // a stop lets go of whatever was loaded: the slot is read again, so the next
  // play starts on the track that sits there now
  await fetch("/api/stop").catch(() => {});
  await syncSlot("keep");
}

function act(action) {
  const a = $("audio");

  switch (action) {
    case "playnpause":
      if (!a) return;
      if (!state.hasAudio) return;          // the slot is empty: nothing to resume
      if (a.paused) {
        const wasStopped = state.stopped;  // a stop leaves a stale drag position
        if (state.stopped) { state.stopped = false; render(); }
        if (wasStopped) {                   // a stop always starts over
          a.currentTime = 0;
          state.pos = 0;
          paintPosition();
        }
        // sitting on the edge means play has to start over; a.ended alone is
        // not reliable right after a seek
        // only the element itself can say "we are at the end"; state.pos may
        // still read 1 after a repair moved the stream back a couple of seconds
        if (a.ended || (a.duration && a.currentTime >= a.duration - 0.05)) {
          a.currentTime = 0;
          state.pos = 0;
          paintPosition();
        }
        // the paused drag only moved the picture; locate now
        if (!wasStopped && a.duration) {
          const at = state.pos * a.duration;      // exactly where the thumb was left
          if (Math.abs(a.currentTime - at) > a.duration * 0.002) a.currentTime = at;
        }
        // a dead element (fatal media error) accepts no play() at all; reopen it
        if (a.error) {
          state.seeking = true;
          state.seekTarget = 0;
          a.src = "/media?play=" + state.playingId + "&t=" + Date.now();
      state.srcChangedAt = Date.now();
          a.load();
          a.addEventListener("loadedmetadata", function once() {
            a.removeEventListener("loadedmetadata", once);
            a.currentTime = state.pos * (a.duration || 0);
            state.seeking = false;
            paintPosition();
            a.play().catch(() => { state.switching = false; refreshButtons(); });
          });
          break;
        }

        a.play().catch(() => { state.switching = false; refreshButtons(); });
      } else {
                a.pause();
      }
      break;
    case "skipback":
      goto(manualPrev());
      return;
    case "skipnext":
      goto(manualNext());
      return;
    case "shuffle":
      toggleShuffle();
      break;
    case "repeat":
      toggleRepeat();
      break;
    case "play":
      if (a) { if (state.stopped) { state.stopped = false; render(); } a.play().catch(() => { state.switching = false; refreshButtons(); }); }
      break;
    case "pause":
      if (a) a.pause();
      break;
    case "stop":
      stopPlayback();
      return;
    case "stopaftercurrent":
      state.stopAfter = !state.stopAfter;
      break;
    case "menu":
      return;                       // the device menu has no preview counterpart
    case "onetrack":
      toggleOneTrack();
      break;
    default:
      return;
  }
  refreshButtons();
}

// which key does something else while held; the device uses this for play only
const HELD_ACTIONS = { playnpause: "stop" };

function wireButton(el, e, skin) {
  const btn = { el, e, skin, pair: null };
  let timer = null, longFired = false;
  // a key may carry a second meaning while held; every other key is just a tap
  const held = HELD_ACTIONS[e.action] || null;

  const showHot = () => { if (btn.pair && btn.pair.hot) el.src = btn.pair.hot; };
  const showRest = () => { if (btn.pair && btn.pair.normal) el.src = btn.pair.normal; };

  // the release is watched on the window: a render can replace this element
  // between press and release, and a release that never arrived used to let the
  // long-press timer fire — which for the play key means stop
  const release = (ev) => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    if (timer) { clearTimeout(timer); timer = null; }
    const wasLong = longFired;
    longFired = false;
    if (state.pressedKey === e.action) state.pressedKey = null;
    showRest();
    // the key on screen may be a newer element than the one that was pressed
    if (state.pressedKey === null) refreshButtons();
    // a tap counts even when a render replaced the key while it was held: the
    // press was meant for this action
    if (!wasLong) {
      if (el.isConnected && ev && ev.preventDefault) ev.preventDefault();
      act(e.action);
    }
  };

  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    longFired = false;
    state.pressedKey = e.action;
    showHot();
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    if (!held) return;
    timer = setTimeout(() => {
      timer = null;
      longFired = true;
      act(held);
      showRest();
    }, 450);
  });

  state.buttons.push(btn);
}

// the device seeks while dragging without pausing; the throttling below only
// keeps a slow source (a network share, say) from queueing a request per pixel
const SEEK_INTERVAL = 120;
let lastSeek = 0;


// one place decides what happens when a track is over

function finishTrack() {
  const a = $("audio");
  if (state.stopAfter) {                 // the device stops here on request
    state.stopAfter = false;
    stopPlayback();
    syncChrome();                        // the box unticks itself
    return;
  }
  const next = autoNext();
  if (next < 0) { stopPlayback(); return; }               // nothing left: stop
  if (next === state.playingId) {                         // that very track again
    cancelDrag();                                        // no drag is in force
    state.stopped = false;
    state.pos = 0;
    paintPosition();
    if (a.error) {
      // the device keeps skipping while the pointer sits at the end; reopen and
      // let the next position take it from there
      a.src = "/media?play=" + state.playingId + "&t=" + Date.now();
      state.srcChangedAt = Date.now();
      a.load();
      // play at once: play() already waits for data, and a rejection still moves
      // the list on instead of leaving the player silently paused
      a.play().catch(() => finishTrack());   // never leave it silently paused
      return;
    }
    a.currentTime = 0;
    if (a.ended) {
      a.load();
      state.srcChangedAt = Date.now();   // the old resource may still report an error
    }
    a.play().catch(() => { state.switching = false; refreshButtons(); });
    return;
  }
  goto(next);
}

// the last fraction of a FLAC has no frame header, so never aim there

function seekNow() {
  const a = $("audio");
  if (!a || !a.duration) return;
  lastSeek = Date.now();
  state.seekTarget = state.pos;
  state.seekWasPlaying = !a.paused;
  // while paused only the picture moves: telling the element would make it
  // open a stream at that offset, and near the end that kills a FLAC
  if (a.paused) return;
  state.seeking = true;                 // cleared when the media lands
  a.currentTime = state.pos * a.duration;
}

// a track change or restart behaves like a pointer at rest: no drag, no pending
// commit, and the clock owns the position again
// the one way to land on the pointer: used by the release
function commitDragSeek() {
  if (state.dragPos == null) return;
  state.pos = state.dragPos;
  paintPosition();
  seekNow();
}

function cancelDrag() {
  clearTimeout(settleTimer);
  state.seeking = false;
}

// the drag is over: commit once and hand the position back
function endDrag() {
  clearTimeout(settleTimer);
  commitDragSeek();
  state.dragPos = null;
  state.seeking = false;
  paintPosition();
}

let settleTimer = null;
// a fast drag outruns the throttle, so once the pointer rests, land exactly
function settleSeek() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (state.dragPos == null) return;
    state.pos = state.dragPos;
    paintPosition();
    seekNow();
  }, 120);
}

function seekThrottled(force) {
  if (force || Date.now() - lastSeek >= SEEK_INTERVAL) seekNow();
}

// One place turns pointer gestures into a 0..1 ratio: a seek bar and a volume bar
// read the same gesture and only differ in what they do with the number.
function wireDrag(el, onRatio, onEnd) {
  let active = false;

  const ratioAt = (ev) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return null;
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  };

  el.addEventListener("pointerdown", (ev) => {
    active = true;
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    const r = ratioAt(ev);
    if (r !== null) onRatio(r, true);
    window.addEventListener("pointerup", () => {
      active = false;
      if (onEnd) onEnd();
    }, { once: true });
  });

  el.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const r = ratioAt(ev);
    if (r !== null) onRatio(r, false);
  });
}

// a volume bar only sets the volume and repaints the bars
function wireVolume(el) {
  el.addEventListener("pointerdown", () => { state.draggingVolume = true; });
  wireDrag(el, (r) => { setVolume(r); }, () => { state.draggingVolume = false; render(); });
}

// a seek bar: the same gesture, but it moves the track instead of the volume
function wireSeek(el) {
  let dragging = false;

  wireDrag(el, (r, first) => {
    if (!dragging) {
      dragging = true;
      state.dragging = true;
      state.seeking = true;
    }
    state.dragPos = r;
    setPos(r);
    seekThrottled(first);
    settleSeek();
  }, () => {
    if (!dragging) return;
    dragging = false;
    state.dragging = false;
    endDrag();
  });

  el.addEventListener("pointercancel", () => { /* the stage was rebuilt; wait for the real up */ });
}


// ------------------------------------------------------------------- audio --

// an exception must be visible: an empty stage is otherwise unexplainable
window.addEventListener("error", (ev) => {
  console.error("skin viewer:", ev.message || "", ev.filename || "", ev.lineno || "");
});

// whether a track is on screen: the skin picks its "playing" arm with this, and
// the toolbar hides its progress with the same answer - one rule, two places
function trackLoaded() { return state.hasAudio && !state.stopped; }
function clockIdle() { return !trackLoaded(); }

// the two clocks always show the player, never a sample string
function refreshElapsed() {
  const text = clockIdle() ? "--:--" : clock(shownTime());
  // the toolbar clock first: it must work even when the skin has no time label
  const cur = $("cur");
  if (cur) cur.textContent = text;
  const t = state.timeNode;
  if (!t || !t.el.isConnected) return;
  const runs = buildRuns(t.raw, t.def, t.source);
  if (runs) t.el.replaceChildren(runs);
}

function updateClocks(root) {
  // while a frame is being built it is still detached, so the caller passes it
  const scope = root || document;
  const elapsed = $("cur") || scope.querySelector("[data-elapsed]");
  if (elapsed) elapsed.textContent = clockIdle() ? "--:--" : clock(shownTime());
  const total = scope.querySelector("[data-total]");
  // the scanned file already knows its length; the element only catches up after
  // it has loaded the new source, so overriding with it here would blank the line
  const scanned = state.fields && state.fields.length;
  if (total && !scanned) total.textContent = mediaDuration() ? clock(mediaDuration()) : "--:--";
}

// ---- playback order -------------------------------------------------------
// The device has three orders that exclude each other (default, shuffle, one
// track) and a repeat switch that works independently of them:
//
//   one track + repeat off  -> stops after the track, play starts it again
//   one track + repeat on   -> that track loops
//   shuffle                 -> affects the end of a track AND the transport keys
//   one track               -> only the end of a track; prev/next follow default
// the list is addressed by position, the audio by identity
function idAt(pos) {
  const row = state.entries[pos];
  return row ? row.id : -1;
}
function fromPos() {
  return state.index >= 0 ? state.index : state.slot;
}
function randomId() {
  const n = state.entries.length;
  if (!n) return -1;
  if (n === 1) return state.entries[0].id;
  const p = fromPos();
  let next = p;
  while (next === p) next = Math.floor(Math.random() * n);
  return idAt(next);
}

function autoNext() {
  const n = state.entries.length;
  if (!n) return -1;
  const pos = fromPos();
  if (state.onetrack) return state.repeatAll && pos >= 0 && pos < n ? idAt(pos) : -1;
  if (state.shuffle) return randomId();
  if (pos + 1 < n) return idAt(pos + 1);
  return state.repeatAll ? idAt(0) : -1;
}

function manualNext() {
  const n = state.entries.length;
  if (!n) return -1;
  if (state.shuffle) return randomId();
  return idAt((fromPos() + 1) % n);
}

function manualPrev() {
  const n = state.entries.length;
  if (!n) return -1;
  if (state.shuffle) return randomId();
  return idAt((fromPos() - 1 + n) % n);
}

// the one place the playing mode changes: the skin's buttons and the toolbar
// both come through here, so every control ends up in the same state
function setModes(next) {
  if ("shuffle" in next) state.shuffle = !!next.shuffle;
  if ("onetrack" in next) state.onetrack = !!next.onetrack;
  if ("repeatAll" in next) state.repeatAll = !!next.repeatAll;
  if ("stopAfter" in next) state.stopAfter = !!next.stopAfter;
  if (state.onetrack) state.shuffle = false;   // the app keeps them exclusive
  if (state.shuffle) state.onetrack = false;
  return modesChanged();
}

function toggleShuffle() { return setModes({ shuffle: !state.shuffle }); }
function toggleOneTrack() { return setModes({ onetrack: !state.onetrack }); }
function toggleRepeat() { return setModes({ repeatAll: !state.repeatAll }); }

function clock(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function attachAudio(a) {
  a.addEventListener("play", () => {
    state.playing = true;
    if (state.stopped || !state.hasAudio) { state.hasAudio = true; state.stopped = false; render(); }
    else refreshButtons();
  });
  a.addEventListener("pause", () => {
    if (state.switching) return;              // caused by swapping the source
    state.playing = false;
    refreshButtons();
  });
  a.addEventListener("playing", () => {
    state.switching = false;
    refreshButtons();
    // tell the server that playback really began: a preloaded row must not count
    if (state.playingId >= 0) fetch("/api/started?id=" + state.playingId).catch(() => {});
  });
  // some sources (FLAC in particular) occasionally fail to open on the first
  // attempt after a jump; one retry with a fresh url recovers them
  a.addEventListener("error", () => {
    if (!a.error || a.error.code !== 4) return;
    // a late error from the resource we just abandoned is not interesting
    if (Date.now() - (state.srcChangedAt || 0) < 1500) {
      // it may be a leftover from the resource we abandoned, but if the element
      // is still broken shortly after, the error is real: decide then instead of
      // swallowing it and leaving the player paused
      // only advance when playback was actually wanted: a source that failed
      // while stopped must not move the list on
      setTimeout(() => {
        if (a.error && a.paused && state.playing && !state.stopped) finishTrack();
      }, 400);
      return;
    }
    // no repair: an element with a fatal error is treated as at the end, so the
    // list moves on (or stops) and the next source starts clean
    if (state.playing && !state.stopped) finishTrack();
  });

  a.addEventListener("timeupdate", () => {
    // while a drag or a seek is in flight the mouse owns the position; letting
    // the clock write here is what made the bars jump about
    if (a.duration && !state.seeking) {
      state.pos = a.currentTime / a.duration;
      if (!state.posUI) render();        // the bar was not on screen yet
      paintPosition();
    }
    updateClocks();
    syncProgress();
  });

  a.addEventListener("ended", () => {
    // a freshly assigned source can report its end from the previous resource;
    // that must not advance the list
    if (state.stopped || Date.now() - (state.srcChangedAt || 0) < 700) return;
    // an "ended" caused by a seek inherits that seek's intent: dragging to the
    // end while playing finishes the track, while paused it is just a jump
    if (Date.now() - lastSeek < 1000 && !state.seekWasPlaying) {
      if (state.dragPos == null) { state.pos = 1; paintPosition(); }
      return;
    }
    finishTrack();
  });
  a.addEventListener("seeked", () => {
    state.seeking = false;
    // while a drag is active the mouse owns the position; the element has only
    // just landed on an older, throttled target
    if (state.dragPos == null && a.duration) {
      state.pos = a.currentTime / a.duration;
      paintPosition();
    }
    syncProgress();
  });
  a.addEventListener("loadedmetadata", () => { updateClocks(); syncProgress(); });
  a.addEventListener("durationchange", () => { updateClocks(); syncProgress(); });
}

// Browsers refuse to play before the first gesture; ask, and take the first
// click anywhere as that gesture.

// take one /api/info (or /api/jump) answer and put the page in that state
// mode: "play" starts the sound, "open" loads the track at its head without
// starting it, "keep" leaves the playback state exactly as it was
async function applyInfo(info, mode = "keep") {
  const play = mode === "play";
  const a = $("audio");
  // the answer is the state: take the ids before anything reads them, or the row
  // highlight and the "is the element already holding this track" test both lie
  state.count = info.count || 0;
  state.playingId = typeof info.playingId === "number" ? info.playingId : -1;
  state.index = typeof info.index === "number" ? info.index : -1;   // -1: that row is gone
  state.slot = typeof info.slot === "number" ? info.slot : -1;      // where a jump starts
  const keep = a && a.getAttribute("src") && a.dataset.trackId === String(state.playingId);

  if (!info.audio) {
    // nothing sits at that position: stay stopped and show nothing
    if (a) { a.pause(); a.removeAttribute("src"); a.dataset.trackId = ""; a.load(); }
    state.hasAudio = false; state.playing = false; state.stopped = true;
    state.pos = 0; state.fields = {}; state.cover = null;
    state.nextFields = {}; state.nextCover = null;
    render(); syncProgress(); highlightRow();
    return;
  }
  if (state.index < 0 && info.loaded && keep) {
    // its row is gone but the sound goes on: leave element, position and skin alone
    state.hasAudio = true;
    highlightRow();
    return;
  }
  cancelDrag();
  state.fields = info.fields || {};
  state.cover = info.cover ? (info.coverUrl || "/cover?play=" + state.playingId) : null;
  state.hasAudio = true;
  // a track is on screen in both "play" and "open"; only "keep" may leave the
  // skin showing its "not playing" arm
  if (play || mode === "open") state.stopped = false;

  if (a) {
    const broken = !!(a.error && a.error.code === 4);
    const reload = !keep || state.stopped || broken;
    if (reload) state.pos = 0;      // a new source starts at its head; a kept one does not
    if (reload) {
      if (!play) state.playing = false;   // opened, not started
      a.dataset.trackId = String(state.playingId);
      a.src = "/media?play=" + state.playingId + "&t=" + Date.now();
      state.srcChangedAt = Date.now();
    }
    // replaygain scales playback, it never moves the volume bar: the bar is the
    // phone's own volume, which replaygain has nothing to do with
    if (info.replaygain && info.replaygain.present) {
      const db = info.replaygain.track || info.replaygain.album || 0;
      state.rgFactor = Math.pow(10, db / 20);
    } else {
      state.rgFactor = 1;
    }
    applyVolume();
    if (play) {
      const start = () => {
        a.play().catch(() => { state.switching = false; state.playing = false; refreshButtons(); });
      };
      if (a.readyState >= 1) start();
      else a.addEventListener("loadedmetadata", start, { once: true });
    }
  }
  prefetchNeighbours();
  await refreshNext();        // the preview belongs to the track, not to a button
  render();
}

async function modesChanged() {
  await refreshNext();
  render();
  refreshButtons();
  syncChrome();
}

async function refreshNext() {
  if (!state.count) { state.nextCover = null; return; }
  let id = autoNext();
  if (id < 0) id = state.playingId;           // nothing after this: show itself
  try {
    const info = await (await fetch("/api/peek?id=" + id, { cache: "no-store" })).json();
    state.nextFields = info.fields || { title: info.title || "", artist: info.artist || "" };
  } catch (e) { /* keep the last one */ }
  state.nextCover = "/cover?play=" + id;
}

async function goto(id) {
  state.switching = true;      // the button art holds until the new track sounds
  // a one track list wraps onto itself: restart it rather than doing nothing
  const a = $("audio");
  // restarting in place is only valid while the element holds that index; after
  // the list was edited the same number can point at another file
  // restart in place only when the element really holds this very track
  const holdsIt = a && a.dataset.trackId === String(id) && !a.error && !state.stopped;
  if (holdsIt) {
    // tell the server as well: it tracks what is loaded, not only the element
    await fetch("/api/jump?id=" + id, { cache: "no-store" }).catch(() => {});
    try {
      a.currentTime = 0;
      await a.play();
    } catch (e) { /* ignore */ }
    return;
  }
  try {
    const info = await (await fetch("/api/jump?id=" + id, { cache: "no-store" })).json();
    await applyInfo(info, "play");
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ chrome --
// The bar duplicates what the skin offers, so the layout can be tried without
// hunting for the right pixel.
function syncChrome() {
  const shape = $("play-shape");
  // our own glyphs: one path each, so the play key just rewrites its shape
  if (shape) shape.setAttribute("d", state.playing ? "M7 5h4v14H7zm6 0h4v14h-4z" : "M8 5v14l11-7z");
  const ord = $("order");
  if (ord) ord.value = state.shuffle ? "shuffle" : state.onetrack ? "one" : "default";
  const rep = $("mode-repeat");
  if (rep) rep.checked = !!state.repeatAll;
  const stop = $("mode-stop");
  if (stop) stop.checked = !!state.stopAfter;
  highlightRow();
}

function highlightRow() {
  const list = $("list");
  if (!list) return;
  // the mark follows the identity: edits to the list move it by themselves, and
  // a deleted row simply stops matching
  const id = state.stopped ? null : String(state.playingId);
  [...list.children].forEach((li) =>
    li.classList.toggle("current", id !== null && li.dataset.id === id));
  const row = list.children[state.index];
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
}

async function loadList() {
  try {
    state.entries = await (await fetch("/api/list", { cache: "no-store" })).json();
  } catch (e) { state.entries = []; }
  prefetchCovers();
  const list = $("list");
  if (!list) return;
  const keepScroll = list.scrollTop;      // inserting a track must not jump home
  list.innerHTML = "";
  state.entries.forEach((entry, i) => {
    const li = document.createElement("li");
    li.dataset.id = String(entry.id);
    li.textContent = entry.title || entry.name;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = entry.artist || tr("artist.unknown");   // always a second line
    li.appendChild(sub);
    li.draggable = true;
    li.dataset.id = String(entry.id);
    li.addEventListener("click", (ev) => {
      if (ev.target.closest(".drop")) return;        // the cross has its own handler
      goto(entry.id);
    });

    const drop = document.createElement("button");
    drop.className = "drop";
    drop.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    drop.title = tr("remove.tip");
    drop.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      // removing the playing row leaves the sound alone; that is the server's
      // business, the client only says which track goes away
      await fetch("/api/remove?id=" + entry.id);
      await loadList();
      await syncSlot("keep");          // the slot now holds another file
      highlightRow();
    });
    li.appendChild(drop);

    li.addEventListener("dragstart", (ev) => {
      li.classList.add("dragging");
      ev.dataTransfer.setData("text/plain", String(i));
      ev.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      [...list.children].forEach((x) => x.classList.remove("over-top", "over-bottom"));
    });
    li.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      const r = li.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      li.classList.toggle("over-bottom", after);
      li.classList.toggle("over-top", !after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("over-top", "over-bottom"));
    li.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const r = li.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      const files = [...(ev.dataTransfer ? ev.dataTransfer.files : [])];
      li.classList.remove("over-top", "over-bottom");
      if (files.length) { await dropFiles(files, after ? i + 1 : i); return; }
      const from = Number(ev.dataTransfer.getData("text/plain"));
      let to = after ? i + 1 : i;
      if (from < to) to -= 1;
      li.classList.remove("over-top", "over-bottom");
      if (!Number.isFinite(from) || from === to) return;
      await fetch("/api/move?from=" + from + "&to=" + to);
      await loadList();
      await syncSlot("keep");          // reordering never changes what plays
    });

    list.appendChild(li);
  });
  highlightRow();
  list.scrollTop = keepScroll;
}


// --------------------------------------------------------------- opening things --
// the one way skins reach the screen: parse, pick, show
async function reloadSkins(selectNew) {
  const before = new Set(skins.keys());
  skins.clear();
  await loadSkin();
  const added = [...skins.keys()].filter((k) => !before.has(k));
  if (selectNew && added.length) state.skin = added[0];
  if (!skins.size) { $("status").textContent = tr("msg.noSkin"); return; }

  const total = [...skins.values()].reduce((n, sk) => n + Object.keys(sk.layouts).length, 0);
  fillSkins();
  render();
  $("status").textContent = tr("msg.loaded", { skins: skins.size, layouts: total });
}

async function uploadSkin(file) {
  // the new package is selected by reloadSkins
  const r = await fetch("/api/upload-skin?name=" + encodeURIComponent(file.name),
                        { method: "POST", body: file });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) { toast(j.error || tr("msg.badSkin")); return; }
  await reloadSkins(true);
}


// one place reads the server's idea of the slot; a list edit bumps its
// generation, which forces a reload even when the index did not move
async function syncSlot(mode = "keep") {
  try {
    const info = await (await fetch("/api/info", { cache: "no-store" })).json();
    await applyInfo(info, mode);
  } catch (e) { /* keep whatever is shown */ }
}

async function pickAndApply(kind) {
  // a playlist may replace any list once playback is stopped; a single file is
  // only opened when the player is empty as well
  const idle = !trackLoaded();
  const emptyIdle = idle && state.count === 0;
  // one dialog at a time: the buttons stay disabled while a pick is pending
  const ids = ["browse-folder", "browse-pkg", "add-audio", "add-list"];
  const buttons = ids.map((id) => $(id)).filter(Boolean);
  if (buttons.some((b) => b.disabled)) return;
  for (const b of buttons) b.disabled = true;
  let j;
  try {
    j = await (await fetch("/api/pick?kind=" + kind)).json();
  } catch (e) { return; }
  finally { for (const b of buttons) b.disabled = false; }
  if (!j.ok) return;                     // cancelled, busy, or nothing to add
  if (kind === "folder" || kind === "package") { await reloadSkins(true); return; }
  await loadList();
  // a playlist takes over whenever playback is stopped; a player that is playing
  // or paused keeps what it holds even when the list behind it was replaced
  await syncSlot(kind === "playlist" ? (idle ? "open" : "keep") : (emptyIdle ? "open" : "keep"));
}

const AUDIO_FILE = /\.(flac|mp3|m4a|mp4|aac|ogg|opus|wav|wv)$/i;
const PLAYLIST_FILE = /\.(m3u|m3u8)$/i;

// what a dropped file may become: a skin package, or audio at a list position

// ------------------------------------------------------- dropped folders --
// A browser hands over files, never a path, so a folder dropped on the page is
// rebuilt here as a store-only .fbskin and handed to the same upload the file
// picker uses. Nothing is compressed: skin payloads are mostly PNG already.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function storeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const { path, bytes } of entries) {
    const name = enc.encode(path);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);         // version needed
    local.setUint16(6, 0x0800, true);     // UTF-8 names
    local.setUint16(8, 0, true);          // stored
    local.setUint16(10, 0, true);         // time
    local.setUint16(12, 0x21, true);      // date (1996-01-01, fixed)
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true);
    cd.setUint32(24, bytes.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + bytes.length;
  }
  let cdSize = 0;
  for (const part of central) cdSize += part.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
                  { type: "application/zip" });
}

// walk a dropped directory, remembering each file's path inside it
function collectEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((f) => { out.push({ path: prefix + entry.name, file: f }); resolve(); }, () => resolve());
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const more = () => reader.readEntries(async (batch) => {
      if (!batch.length) return resolve();
      for (const e of batch) await collectEntry(e, prefix + entry.name + "/", out);
      more();
    }, () => resolve());
    more();
  });
}

async function uploadDroppedFolder(dirEntry) {
  const found = [];
  await collectEntry(dirEntry, "", found);
  const ours = found.filter((x) => !/(^|\/)\.|__MACOSX|Thumbs\.db$/i.test(x.path));
  if (!ours.length) { toast(tr("msg.unsupported")); return; }
  const entries = [];
  for (const item of ours) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    entries.push({ path: item.path, bytes });
  }
  const blob = storeZip(entries);
  await uploadSkin(new File([blob], (dirEntry.name || "dropped") + ".fbskin"));
}

async function dropFiles(files, at) {
  const pkg = files.find((f) => /\.(fbskin|zip)$/i.test(f.name));
  if (pkg) { await uploadSkin(pkg); return; }
  if (files.some((f) => PLAYLIST_FILE.test(f.name))) { toast(tr("msg.noListDrop")); return; }
  const bad = files.find((f) => !AUDIO_FILE.test(f.name));
  if (bad) { toast(tr("msg.unsupported")); return; }
  await uploadAudio(files, at == null ? "append" : "insert", at);
}

async function uploadAudio(files, mode = "append", at = null) {
  const idle = !trackLoaded() && state.count === 0;   // empty player, nothing loaded
  for (let i = 0; i < files.length; i++) {
    let q = "?name=" + encodeURIComponent(files[i].name);
    if (mode === "insert") q += "&mode=insert&at=" + ((at == null ? 0 : at) + i);
    else if (mode === "replace") q += "&mode=replace";
    await fetch("/api/upload-audio" + q, { method: "POST", body: files[i] });
  }
  await loadList();
  // an idle player opens the file at its head without starting it; a player that
  // already holds a track is left alone
  await syncSlot(idle ? "open" : "keep");
}

function wireOpening() {
  const browseFolder = $("browse-folder"), browsePkg = $("browse-pkg");
  if (browseFolder) browseFolder.addEventListener("click", () => pickAndApply("folder"));
  if (browsePkg) browsePkg.addEventListener("click", () => pickAndApply("package"));

  const pickSkin = $("pick-skin");
  if (pickSkin) pickSkin.addEventListener("change", () => {
    if (pickSkin.files && pickSkin.files[0]) uploadSkin(pickSkin.files[0]);
    pickSkin.value = "";
  });
  const addBtn = $("add-audio"), listBtn = $("open-list");
  const addInput = $("pick-audio-add"), listInput = $("pick-audio-list");
  const clearBtn = $("clear-list");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    await fetch("/api/clear-list", { method: "POST" }).catch(() => {});
    await loadList();
    await syncSlot("keep");        // emptying never stops what is sounding
  });
  if (addBtn) addBtn.addEventListener("click", () => pickAndApply("audio"));
  if (listBtn) listBtn.addEventListener("click", () => pickAndApply("playlist"));
  if (addInput) addInput.addEventListener("change", () => {
    if (addInput.files && addInput.files.length) uploadAudio([...addInput.files], "append");
    addInput.value = "";
  });
  if (listInput) listInput.addEventListener("change", () => {
    if (listInput.files && listInput.files.length) uploadAudio([...listInput.files], "replace");
    listInput.value = "";
  });

  const pickAudio = $("pick-audio");
  if (pickAudio) pickAudio.addEventListener("change", () => {
    if (pickAudio.files && pickAudio.files.length) uploadAudio([...pickAudio.files], "append");
    pickAudio.value = "";
  });

  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    const items = [...(e.dataTransfer ? e.dataTransfer.items : [])];
    const dir = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
                     .find((en) => en && en.isDirectory);
    if (dir) { await uploadDroppedFolder(dir); return; }
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (files.length) dropFiles(files, null);
  });
}


// --------------------------------------------------------------- prefs --
// language follows the browser unless the user picked one; the theme has three
// states, so "follow the system" is a real choice rather than a default
const I18N = {
  zh: {
    "app.title": "fb2km Skin Viewer",
    "open.skin": "打开皮肤目录",
    "open.pkg": "打开皮肤包",
    "skin": "皮肤",
    "layout": "布局",
    "add.audio": "打开音频文件",
    "open.list": "打开播放列表",
    "theme.auto": "跟随系统",
    "theme.light": "浅色",
    "theme.dark": "深色",
    "lang.label": "语言",
    "clear": "清空",
    "follow": "跟随布局尺寸",
    "sim.label": "状态栏",
    "device.tip": "真机屏幕尺寸（像素）",
    "sim.tip": "按真机的方式压缩皮肤并画出状态栏",
    "open.skin.tip": "实时监测改动",
    "open.pkg.tip": "*.fbskin / *.zip",
    "add.audio.tip": "追加到播放列表",
    "open.list.tip": "替换整个播放列表",
    "remove.tip": "从播放列表移除",
    "msg.noSkin": "这个页面旁边没有找到皮肤",
    "msg.noLayout": "skindef.txt 里没有列出任何布局",
    "msg.loaded": "已加载 {skins} 份皮肤、{layouts} 个布局",
    "clear.list": "清空播放列表",
    "msg.unsupported": "不支持该操作",
    "msg.badSkin": "不是有效的皮肤包",
    "msg.noListDrop": "播放列表不能拖入，请用「打开播放列表」",
    "msg.badPackage": "无法读取这个皮肤包",
    "artist.unknown": "未知艺术家",
    "order": "顺序",
    "order.default": "默认",
    "order.one": "单曲",
    "order.shuffle": "随机",
    "repeat": "重复",
    "stop.after": "当前曲目后停止",
  },
  en: {
    "app.title": "fb2km Skin Viewer",
    "open.skin": "Open skin folder",
    "open.pkg": "Open skin package",
    "skin": "Skin",
    "layout": "Layout",
    "add.audio": "Open audio",
    "open.list": "Open playlist",
    "theme.auto": "Follow the system",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "lang.label": "Language",
    "clear": "Clear",
    "follow": "Follow the layout size",
    "sim.label": "Status bar",
    "device.tip": "device screen size in pixels",
    "sim.tip": "squeeze the skin as the phone does and draw its status bar",
    "open.skin.tip": "changes are watched live",
    "open.pkg.tip": "*.fbskin / *.zip",
    "add.audio.tip": "append to the playlist",
    "open.list.tip": "replace the playlist",
    "remove.tip": "remove from the list",
    "msg.noSkin": "no skin served next to this page",
    "msg.noLayout": "skindef.txt lists no layouts",
    "msg.loaded": "loaded {skins} skin(s), {layouts} layouts",
    "clear.list": "Clear the playlist",
    "msg.unsupported": "That cannot be dropped here",
    "msg.badSkin": "This is not a valid skin package",
    "msg.noListDrop": "Playlists cannot be dropped; use \u201cOpen playlist\u201d",
    "msg.badPackage": "cannot read that package",
    "artist.unknown": "Unknown artist",
    "order": "Order",
    "order.default": "Default",
    "order.one": "One Track",
    "order.shuffle": "Shuffle",
    "repeat": "Repeat",
    "stop.after": "Stop after current",
  },
};

const THEMES = ["auto", "light", "dark"];
// half-filled circle, sun and moon, drawn rather than typed
// material symbols rounded: contrast, light_mode and dark_mode
const ICON = {
  auto: '<path d="M324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM500-140q137-10 228.5-106T820-480q0-138-91.5-234T500-820v680Z"/>',
  light: '<path d="M579-380.76q41-40.77 41-99Q620-538 579.24-579q-40.77-41-99-41Q422-620 381-579.24q-41 40.77-41 99Q340-422 380.76-381q40.77 41 99 41Q538-340 579-380.76ZM338.5-338.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM70-450q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32Q57.25-510 70-510h100q12.75 0 21.38 8.68 8.62 8.67 8.62 21.5 0 12.82-8.62 21.32-8.63 8.5-21.38 8.5H70Zm720 0q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32 8.62-8.5 21.37-8.5h100q12.75 0 21.38 8.68 8.62 8.67 8.62 21.5 0 12.82-8.62 21.32-8.63 8.5-21.38 8.5H790ZM458.5-768.63Q450-777.25 450-790v-100q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v100q0 12.75-8.68 21.37-8.67 8.63-21.5 8.63-12.82 0-21.32-8.63Zm0 720Q450-57.25 450-70v-100q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v100q0 12.75-8.68 21.37-8.67 8.63-21.5 8.63-12.82 0-21.32-8.63ZM240-678l-57-56q-9-9-8.63-21.6.37-12.61 8.53-21.5 8.89-8.9 21.5-8.9 12.6 0 21.6 9l56 57q8 9 8 21t-8 20.5q-8 8.5-20.5 8.5t-21.5-8Zm494 495-56-57q-8-9-8-21.38 0-12.37 8.5-20.62 8.5-9 20.5-9t21 9l57 56q9 9 8.63 21.6-.37 12.61-8.53 21.5-8.89 8.9-21.5 8.9-12.6 0-21.6-9Zm-56-495q-9-9-9-21t9-21l56-57q9-9 21.6-8.63 12.61.37 21.5 8.53 8.9 8.89 8.9 21.5 0 12.6-9 21.6l-57 56q-8 8-20.36 8-12.37 0-21.64-8ZM182.9-182.9q-8.9-8.89-8.9-21.5 0-12.6 9-21.6l57-56q8.8-9 20.9-9 12.1 0 20.71 9 9.39 9 9.39 21t-9 21l-56 57q-9 9-21.6 8.63-12.61-.37-21.5-8.53ZM480-480Z"/>',
  dark: '<path d="M480-120q-150 0-255-105T120-480q0-135 79.5-229T408-830q20-5 34-1t22 15q8 10 7.5 25t-8.5 35q-9 23-14 47t-5 49q0 90 63 153t153 63q25 0 48.5-4.5T754-461q22-8 38-7t26 9q10 8 13 23t-2 36q-27 121-121 200.5T480-120Zm0-60q109 0 190-67.5T771-406q-25 11-53.5 16.5T660-384q-115 0-195.5-80.5T384-660q0-24 5-51.5t18-62.5q-98 27-162.5 109.5T180-480q0 125 87.5 212.5T480-180Zm-4-297Z"/>',
};

// status bar glyphs: wifi arcs and a battery, drawn in the bar's own colour
// filled bands, like the one Android draws: outlines read as a smudge at this
// size, solid shapes stay clean
const SIM_WIFI =
  // bootstrap icons: wifi
  '<svg class="sim-wifi" viewBox="0 0 16 16" fill="currentColor">' +
  '<path d="M15.384 6.115a.485.485 0 0 0-.047-.736A12.44 12.44 0 0 0 8 3C5.259 3 2.723 3.882.663 5.379a.485.485 0 0 0-.048.736.52.52 0 0 0 .668.05A11.45 11.45 0 0 1 8 4c2.507 0 4.827.802 6.716 2.164.205.148.49.13.668-.049"/>' +
  '<path d="M13.229 8.271a.482.482 0 0 0-.063-.745A9.46 9.46 0 0 0 8 6c-1.905 0-3.68.56-5.166 1.526a.48.48 0 0 0-.063.745.525.525 0 0 0 .652.065A8.46 8.46 0 0 1 8 7a8.46 8.46 0 0 1 4.576 1.336c.206.132.48.108.653-.065m-2.183 2.183c.226-.226.185-.605-.1-.75A6.5 6.5 0 0 0 8 9c-1.06 0-2.062.254-2.946.704-.285.145-.326.524-.1.75l.015.015c.16.16.407.19.611.09A5.5 5.5 0 0 1 8 10c.868 0 1.69.201 2.42.56.203.1.45.07.61-.091zM9.06 12.44c.196-.196.198-.52-.04-.66A2 2 0 0 0 8 11.5a2 2 0 0 0-1.02.28c-.238.14-.236.464-.04.66l.706.706a.5.5 0 0 0 .707 0l.707-.707z"/></svg>';
const SIM_BATTERY =
  // bootstrap icons: battery-full
  '<svg class="sim-bat" viewBox="0 2.5 16 11" fill="currentColor">' +
  '<path d="M2 6h10v4H2z"/>' +
  '<path d="M2 4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm10 1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm4 3a1.5 1.5 0 0 1-1.5 1.5v-3A1.5 1.5 0 0 1 16 8"/></svg>';

// a short line at the bottom of the screen, for things that are refused. Every
// message is its own popup: a new one rises over the one still standing there
function toast(text) {
  if (!text) return;
  // the message before this one steps aside at once: the new popup rises from
  // the bottom on its own, instead of the old text simply changing
  for (const old of document.querySelectorAll(".toast")) {
    old.classList.remove("show");
    setTimeout(() => old.remove(), 240);
  }
  const box = document.createElement("div");
  box.className = "toast";
  box.textContent = text;
  document.body.appendChild(box);
  void box.offsetWidth;                  // let the initial style settle first
  box.classList.add("show");
  setTimeout(() => {
    box.classList.remove("show");
    setTimeout(() => box.remove(), 240);
  }, 3000);
}

function tr(key, vars) {
  const dict = I18N[state.lang] || I18N.en;
  let text = dict[key] || key;
  if (vars) for (const k of Object.keys(vars)) text = text.replace("{" + k + "}", vars[k]);
  return text;
}

function pickLang() {
  const saved = localStorage.getItem("lang");
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function applyLang() {
  const dict = I18N[state.lang] || I18N.en;
  document.documentElement.lang = state.lang;
  const t = (key) => dict[key] || key;
  const set = (id, key) => { const el = $(id); if (el) el.textContent = t(key); };
  set("browse-folder", "open.skin");
  set("browse-pkg", "open.pkg");
  set("add-audio", "add.audio");
  set("open-list", "open.list");
  set("clear-list", "clear");
  const tip = (id, key) => { const el = $(id); if (el) el.title = t(key); };
  tip("browse-folder", "open.skin.tip");
  tip("browse-pkg", "open.pkg.tip");
  tip("add-audio", "add.audio.tip");
  tip("open-list", "open.list.tip");
  tip("clear-list", "clear.list");
  const lab = document.querySelector(".lang-label");
  if (lab) lab.textContent = t("lang.label");
  set("follow-label", "follow");
  set("sim-label", "sim.label");
  const dwEl = $("device-w"), dhEl = $("device-h");
  if (dwEl) dwEl.title = t("device.tip");
  if (dhEl) dhEl.title = t("device.tip");
  const simLab = document.querySelectorAll("#devicebar .check");
  if (simLab.length) simLab[simLab.length - 1].title = t("sim.tip");

  const orderLabel = $("order-label");
  if (orderLabel) {
    [...orderLabel.childNodes].forEach((n) => {
      if (n.nodeType === 3 && n.textContent.trim()) n.textContent = " " + t("order") + " ";
    });
    const opts = $("order");
    if (opts) {
      opts.options[0].textContent = t("order.default");
      opts.options[1].textContent = t("order.one");
      opts.options[2].textContent = t("order.shuffle");
    }
    const rl = $("repeat-label"); if (rl) rl.textContent = t("repeat");
    const sl = $("stop-label"); if (sl) sl.textContent = t("stop.after");
  }
  const ls = $("lang");
  if (ls && ls.value !== state.lang) ls.value = state.lang;
  // the two select labels carry text nodes before their <select>
  document.querySelectorAll("header label").forEach((lab) => {
    const sel = lab.querySelector("select");
    if (!sel) return;
    const key = sel.id === "skin" ? "skin" : sel.id === "layout" ? "layout" : null;
    if (!key) return;
    [...lab.childNodes].forEach((n) => {
      if (n.nodeType === 3 && n.textContent.trim()) n.textContent = " " + t(key) + " ";
    });
  });
}

function applyTheme() {
  // ?theme=light makes a screenshot of that theme possible
  const asked = new URLSearchParams(location.search).get("theme");
  document.documentElement.dataset.theme = asked || state.theme;
  const b = $("theme-toggle");
  if (b) {
    b.innerHTML = '<svg viewBox="0 -960 960 960">' +
                  (ICON[state.theme] || ICON.auto) + "</svg>";
    const dict = I18N[state.lang] || I18N.en;
    b.title = dict["theme." + state.theme] || "";
  }
}


// The address always describes what is on screen, so copying it reproduces the
// view. replaceState keeps the back button meaning "leave" rather than "undo".
// what the canvas is actually made of, in the same terms the address uses
function shownDevice() {
  const skin = skins.get(state.skin);
  const L = skin && state.layout ? skin.layouts[state.layout] : null;
  const fallbackW = (L && L.w) || 1080;
  const fallbackH = (L && L.h) || 2400;
  return {
    w: state.deviceFollow ? fallbackW : Math.max(120, state.deviceW || fallbackW),
    h: state.deviceFollow ? fallbackH : Math.max(120, state.deviceH || fallbackH),
  };
}

function shownStatusHeight() {
  const d = shownDevice();
  const automatic = Math.max(8, Math.round(Math.min(d.w, d.h) / 15));
  return state.deviceFollow ? automatic : (state.statusBarH || automatic);
}

function syncUrl() {
  // one state, one address: the keys always come in this order and a value that
  // matches the default is left out, so the same view always serialises the same
  const q = new URLSearchParams();
  if (state.skin) q.set("skin", state.skin);
  if (state.layout) q.set("layout", state.layout);
  // dev carries the whole follow switch, so there is no separate flag for it
  q.set("dev", state.deviceFollow
    ? "auto"
    : (state.deviceW && state.deviceH ? state.deviceW + "x" + state.deviceH
                                      : (() => { const d = shownDevice(); return d.w + "x" + d.h; })()));
  // the height only shows while the size is manual: under dev=auto it is worked
  // out from the size and would only be noise
  if (!state.deviceFollow) q.set("st", String(shownStatusHeight()));
  q.set("bar", state.simStatus ? "1" : "0");
  if (state.lang) q.set("lang", state.lang);
  q.set("theme", state.theme || "auto");
  const next = location.pathname + "?" + q.toString();
  if (next !== location.pathname + location.search) {
    history.replaceState(null, "", next);
  }
}

function wirePrefs() {
  // Three things stay apart here. A value in the address is a one-off instruction
  // applied while loading; the address is then kept in step with what is on screen;
  // and whatever the address cannot express simply lives inside the page.
  const q = new URLSearchParams(location.search);
  const OURS = ["dev", "st", "bar", "sim", "theme", "lang", "skin", "layout"];
  // an address that says anything at all describes the whole view, so a copied
  // address always reproduces the same screen; only a bare address falls back to
  // what this copy of the page used last time
  const fromUrl = OURS.some((k) => q.has(k));

  state.lang = pickLang();
  const wantLang = q.get("lang");
  if (wantLang === "zh" || wantLang === "en") state.lang = wantLang;
  else if (!fromUrl) state.lang = localStorage.getItem("lang") || state.lang;
  state.theme = fromUrl ? "auto" : (localStorage.getItem("theme") || "auto");
  const forced = q.get("theme");
  if (forced && THEMES.includes(forced)) state.theme = forced;   // handy for screenshots
  if (!THEMES.includes(state.theme)) state.theme = "auto";
  applyTheme();
  applyLang();

  const ls = $("lang");
  if (ls) {
    ls.value = state.lang;
    ls.addEventListener("change", () => {
      state.lang = ls.value === "zh" ? "zh" : "en";
      localStorage.setItem("lang", state.lang);
      syncUrl();
      applyLang();
      applyTheme();
    });
  }
  const tt = $("theme-toggle");
  if (tt) tt.addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    state.theme = next;
    localStorage.setItem("theme", next);
    syncUrl();
    applyTheme();
  });

  state.simStatus = fromUrl ? false : localStorage.getItem("simStatus") === "1";
  state.deviceFollow = fromUrl ? true : localStorage.getItem("deviceFollow") !== "0";
  state.deviceW = fromUrl ? 0 : (parseInt(localStorage.getItem("deviceW") || "0", 10) || 0);
  state.deviceH = fromUrl ? 0 : (parseInt(localStorage.getItem("deviceH") || "0", 10) || 0);
  state.statusBarH = fromUrl ? 0 : (parseInt(localStorage.getItem("statusBarH") || "0", 10) || 0);

  // dev is the one switch behind "follow the layout": auto, a size, or silence
  const dev = q.get("dev");
  if (dev === "auto") {
    state.deviceFollow = true;
  } else if (dev && /^\d+x\d+$/.test(dev)) {
    const [w, h] = dev.split("x").map(Number);
    state.deviceFollow = false;
    state.deviceW = Math.max(120, Math.min(8000, w));
    state.deviceH = Math.max(120, Math.min(8000, h));
  }
  // st is a one-off too: auto works the height out again, a number sets it. It has
  // no say in whether the size follows, so dev=auto&st=100 keeps the 100 in hand
  const st = q.get("st");
  if (st === "auto") state.statusBarH = 0;
  else if (st && parseInt(st, 10) > 0) state.statusBarH = Math.max(8, Math.min(600, parseInt(st, 10)));
  const bar = q.get("bar") !== null ? q.get("bar") : q.get("sim");   // sim is the older name
  if (bar === "1") state.simStatus = true;
  if (bar === "0") state.simStatus = false;

  const sb = $("sim-status");
  if (sb) {
    sb.checked = state.simStatus;
    sb.addEventListener("change", () => {
      state.simStatus = sb.checked;
      localStorage.setItem("simStatus", sb.checked ? "1" : "0");
      syncUrl();
      render();
    });
  }
  const fs = $("device-follow");
  if (fs) {
    fs.checked = state.deviceFollow;
    fs.addEventListener("change", () => {
      state.deviceFollow = fs.checked;
      localStorage.setItem("deviceFollow", fs.checked ? "1" : "0");
      syncUrl();
      render();
    });
  }
  const sw = $("status-h");
  if (sw) {
    const applyHeight = (rewrite) => {
      // clearing the field works the height out once and keeps the number: the
      // page has no hidden "automatic" mode to fall back into
      const fallback = Math.max(8, Math.round(Math.min(state.deviceW || 1080,
                                                       state.deviceH || 2400) / 15));
      const typed = parseInt(sw.value, 10);
      const next = sw.value.trim() === "" || !typed ? fallback : Math.max(8, Math.min(600, typed));
      if (next === state.statusBarH && !rewrite) return;
      state.statusBarH = next;
      localStorage.setItem("statusBarH", String(next));
      syncUrl();
      render();
    };
    sw.addEventListener("input", () => applyHeight(false));
    sw.addEventListener("change", () => applyHeight(true));
  }
  const dw = $("device-w"), dh = $("device-h");
  const readDims = () => {
    if (!dw || !dh) return;
    const w = Math.max(120, Math.min(8000, parseInt(dw.value, 10) || 0));
    const h = Math.max(120, Math.min(8000, parseInt(dh.value, 10) || 0));
    if (!w || !h) return;
    state.deviceW = w; state.deviceH = h;
    localStorage.setItem("deviceW", String(w));
    localStorage.setItem("deviceH", String(h));
    syncUrl();
    render();
  };
  if (dw) dw.addEventListener("change", readDims);
  if (dh) dh.addEventListener("change", readDims);
}

function wireModes() {
  const ord = $("order");
  if (ord) ord.addEventListener("change", () =>
    setModes({ onetrack: ord.value === "one", shuffle: ord.value === "shuffle" }));
  const rep = $("mode-repeat");
  if (rep) rep.addEventListener("change", () => setModes({ repeatAll: rep.checked }));
  const stop = $("mode-stop");
  if (stop) stop.addEventListener("change", () => setModes({ stopAfter: stop.checked }));
}

function wireChrome() {
  $("btn-prev").addEventListener("click", () => goto(manualPrev()));
  $("btn-next").addEventListener("click", () => goto(manualNext()));
  $("btn-play").addEventListener("click", () => act("playnpause"));
  $("btn-stop").addEventListener("click", () => stopPlayback());

  // dragging must not be fought by the player echoing its own position back
  const seek = $("seek");
  // the value is only updated by the following input event, so seeking here
  // would jump to the position the thumb is leaving, not the one it lands on
  let firstInput = false;
  seek.addEventListener("pointerdown", () => {
    state.seeking = true;
    state.dragging = true;
    firstInput = true;
    window.addEventListener("pointerup", () => {
      if (!state.dragging) return;
      state.dragging = false;
      endDrag();
    }, { once: true });
  });
  seek.addEventListener("blur", () => { state.seeking = false; });
  seek.addEventListener("input", () => {
    state.dragPos = seek.value / 1000;
    setPos(state.dragPos);
    if (firstInput) { firstInput = false; seekNow(); }
    else { seekThrottled(false); settleSeek(); }
  });
  const doneSeeking = () => { state.dragging = false; endDrag(); };
  seek.addEventListener("change", doneSeeking);
  seek.addEventListener("pointerup", doneSeeking);
  seek.addEventListener("pointercancel", doneSeeking);
}

// the bar and the two clocks follow the player
function syncProgress() {
  const a = $("audio");
  const seek = $("seek");
  const cur = $("cur");
  const dur = $("dur");
  if (!a) return;
  // with nothing loaded the bar and the elapsed clock say nothing: hide both,
  // exactly like the skin hides its own clock labels
  const idle = clockIdle();
  if (seek) {
    // the rail stays as a background; only the progress and the knob go away,
    // and with them the ability to drag
    seek.disabled = idle;
    seek.classList.toggle("idle", idle);
    if (!idle) paintPosition();
  }
  if (cur) cur.textContent = idle ? "--:--" : clock(a.currentTime || 0);
  if (dur) dur.textContent = idle || !a.duration ? "--:--" : clock(a.duration);
}

// ------------------------------------------------------------- skin loading --
async function loadSkin() {
  const status = $("status");
  const found = [];
  let labels = ["skin"];
  try {
    const listed = await (await fetch("/api/skins", { cache: "no-store" })).json();
    if (Array.isArray(listed) && listed.length) labels = listed;
  } catch (e) { /* older viewer */ }
  for (const label of labels) {
    // every skin lives under its own prefix, so opening another one adds to the
    // list instead of replacing it
    // the separator between a folder and its subskin must survive encoding
    const base = "/skin/" + encodeURIComponent(label).replace(/%2F/gi, "/") + "/";
    // the entrypoint is skindef.txt, or skindef.skindef in skins built by the old
    // designer; the first name that answers is the one this skin uses
    for (const defName of DEF_NAMES) {
      try {
        const r = await fetch(base + defName, { cache: "no-store" });
        if (r.ok) { found.push({ base, name: label, def: defName }); break; }
      } catch (e) { /* not there */ }
    }
  }
  if (!found.length) { status.textContent = tr("msg.noSkin"); return; }

  for (const { base, name, def } of found) {
    let text;
    try {
      text = dec16(await (await fetch(base + def, { cache: "no-store" })).arrayBuffer());
    } catch (e) { continue; }
    const entry = { def: parseSkindef(text), layouts: {},
                    base: base.startsWith("/") ? base : "./" + base };
    // the old designer's entry name is the only marker of a 1.x skin, and the two
    // extra artwork types below are its feature
    entry.def.oldFormat = def === "skindef.skindef";
    const decls = [...text.matchAll(/^skin:\s*(\d+)x(\d+)[^\s]*\s+(\S+\.txt)\s*$/gm)]
      .map((m) => ({ w: +m[1], h: +m[2], file: m[3] }));
    const names = decls.length
      ? decls.map((d) => d.file)
      : [...text.matchAll(/^skin:\s*\S*\s+(\S+\.txt)\s*$/gm)].map((m) => m[1]);
    for (const n of names) {
      try {
        const r = await fetch(base + n, { cache: "no-store" });
        if (!r.ok) continue;
        const decl = decls.find((d) => d.file === n);
        entry.layouts[n] = parseLayout(dec16(await r.arrayBuffer()), entry.def, decl);
      } catch (e) { /* skip */ }
    }
    // an element the viewer does not know is worth one line in the console, once
    if (state.unknown && state.unknown.size) {
      const names = [...state.unknown].join(" ");
      state.unknown.clear();
      fetch("/api/log?msg=" + encodeURIComponent("layout  not drawn " + names)).catch(() => {});
    }
    // pull every picture in once: the server may be gone later, and a button that
    // has to fetch its other state would fall back to a broken image
    const seen = new Set();
    const warmed = [];
    const warm = (file) => {
      if (!file || seen.has(file)) return;
      seen.add(file);
      const url = imgURL(entry, file);
      if (!url) return;
      const im = new Image();
      im.src = url;
      warmed.push(fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => { if (b) state.blobs.set(entry.base + file, URL.createObjectURL(b)); })
        .catch(() => {}));
    };
    for (const layout of Object.values(entry.layouts)) {
      for (const el of layout.els || []) {
        warm(el.src); warm(el.src2); warm(el.hot); warm(el.hot2); warm(el.knob);
      }
    }
    warm(entry.def.defaultart);
    // once the bytes are in memory the stage can be redrawn from them
    Promise.all(warmed).then(() => { if (state.skinsReady) render(); });

    skins.set(name, entry);
  }

}

function fillSkins() {
  const sel = $("skin");
  sel.innerHTML = "";
  for (const name of skins.keys()) {
    const o = document.createElement("option");
    o.value = name;
    const e = skins.get(name);
    o.textContent = (e && e.def && e.def.name) || name;
    sel.appendChild(o);
  }
  // rebuild the options but keep the chosen skin: rebuilding alone resets the
  // element to its first entry, which undid a selection made moments earlier
  // ?skin= picks one by name, which makes a render reproducible for a report
  const asked = new URLSearchParams(location.search).get("skin");
  if (asked && skins.has(asked)) state.skin = asked;
  const keep = skins.has(state.skin) ? state.skin : null;
  sel.value = keep || sel.value || skins.keys().next().value;
  state.skin = sel.value;
  // the picker is the only place a skin is named, whether there is one or many
  const entry = skins.get(state.skin);
  const def = (entry && entry.def) || {};
  sel.title = (state.skinRoot ? "folder " + state.skinRoot : "")
            + (def.version ? " · version " + def.version : "");
  fillLayouts();
}

function fillLayouts() {
  const skin = skins.get(state.skin);
  const sel = $("layout");
  sel.innerHTML = "";
  if (!skin) return;
  for (const name of Object.keys(skin.layouts)) {
    const o = document.createElement("option");
    o.value = name;
    const e = skins.get(name);
    o.textContent = (e && e.def && e.def.name) || name;
    sel.appendChild(o);
  }
  const names = Object.keys(skin.layouts);
  // the skin's own order decides; a remembered choice wins for this skin
  const remembered = localStorage.getItem("layout:" + state.skin);
  // ?layout= picks one by name, which makes a render reproducible for a bug report
  const asked = new URLSearchParams(location.search).get("layout");
  state.layout = (asked && names.includes(asked)) ? asked
    : (remembered && names.includes(remembered)) ? remembered
    : (preferredLayout(skin) || names[0]);
  sel.value = state.layout;
  syncUrl();
}

// ------------------------------------------------------------------- wiring --
$("skin").addEventListener("change", (e) => { state.skin = e.target.value; fillLayouts(); render(); });
$("layout").addEventListener("change", (e) => {
  state.layout = e.target.value;
  localStorage.setItem("layout:" + state.skin, state.layout);
  syncUrl();
  render();
});
    window.addEventListener("resize", () => { render(); refit(); });
window.addEventListener("load", async () => {
  attachAudio($("audio"));
  wireChrome();
  wireOpening();
  wirePrefs();
  wireModes();
  // every image url carries the fingerprint, so it must be known before the first
  // render: otherwise the next render asks for different urls and the browser
  // reloads the art, which showed up as a blank frame on the first track change
  try {
    const ver = await (await fetch("/api/version", { cache: "no-store" })).json();
    state.fingerprint = ver.v || "";
    state.skinRoot = ver.root || "";
  } catch (e) { /* older viewer, no version route */ }
  try {
    hints = await (await fetch("/api/settings", { cache: "no-store" })).json();
  } catch (e) { /* older viewer, no settings route */ }
  await reloadSkins(false);
  state.skinsReady = true;
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
  await loadList();
  await syncSlot("open");           // the list starts on its first entry, paused
  setInterval(pollSkin, 1000);
});

// the viewer fingerprints the skin folder, so an edit shows up without a reload
async function pollSkin() {
  let v;
  try {
    v = (await (await fetch("/api/version", { cache: "no-store" })).json()).v;
  } catch (e) { return; }
  if (!v || v === state.fingerprint) return;
  state.fingerprint = v;
  await reloadSkins(false);   // re-reads skindef, keeps the selection, redraws
}
