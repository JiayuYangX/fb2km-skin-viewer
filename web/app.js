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

function fillSkins() {
  const sel = $("skin");
  const names = [...skins.keys()];
  sel.innerHTML = "";
  for (const name of names) {
    const o = document.createElement("option");
    o.value = name;
    const e = skins.get(name);
    o.textContent = (e && e.def && e.def.name) || name;
    sel.appendChild(o);
  }
  // the element only ever mirrors state.skin; it is never read back
  if (!skins.has(state.skin)) state.skin = names[0] || null;
  if (state.skin) sel.value = state.skin;

  const entry = skins.get(state.skin);
  const def = (entry && entry.def) || {};
  sel.title = (state.skinRoot ? "folder " + state.skinRoot : "")
            + (def.version ? " · version " + def.version : "");
  fillLayouts();
  return names.length;
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
  gesture: 0, pressGesture: -1, longGesture: -1,   // which press is which
};

const skins = new Map();          // name -> { def, layouts, base }

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
const LABEL_FLOOR = 0.58;
const fitCanvas = document.createElement("canvas").getContext("2d");

// the text is measured on a canvas: once a label is ellipsized its laid-out
// width is the clipped one, so the DOM cannot tell us it is still too wide
function textWidth(el, size) {
  const cs = getComputedStyle(el);
  fitCanvas.font = cs.fontStyle + " " + cs.fontWeight + " " + size + "px " + cs.fontFamily;
  return fitCanvas.measureText(el.textContent || "").width;
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

function resolveColour(value, def) {
  const v = (value || "").trim();
  for (const key of [v, v + "col", v + "font"]) {
    if (def.colours[key]) return def.colours[key];
  }
  if (/^\d+,\d+,\d+$/.test(v)) return "rgb(" + v + ")";
  return null;
}

// ------------------------------------------------------------------ parser --
// mode "playing" takes the first arm of a conditional, "other" the else arm;
// radio blocks are always skipped because we preview a local track.
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

    if (line === "[rectangle]") {
      const c = resolveColour(lines[i + 1], def);
      const [x, y, w, h] = lines[i + 2].split(",").map(Number);
      if (c) els.push({ t: "rect", x, y, w, h, c });
      i += 3; continue;
    }
    if (line === "[label]") {
      const [x, y, w, h] = lines[i + 1].split(",").map(Number);
      const align = lines[i + 2].split(",")[0].trim();
      const content = lines[i + 3] || "";
      const st = labelStyle(content, def);
      const src = /\[infosource-([\w-]+)\]/.exec(content);
      els.push({ t: "label", x, y, w, h, align, c: st.c || null, b: st.b, i: st.i,
                   raw: content, source: src ? src[1] : "" });
      i += 4; continue;
    }
    if (line === "[image]") {
      const [x, y, w, h] = lines[i + 2].split(",").map(Number);
      els.push({ t: "image", x, y, w, h, src: lines[i + 1].trim() });
      i += 3; continue;
    }
    if (line === "[albumart]") {
      const [x, y, w, h] = lines[i + 1].split(",").map(Number);
      const source = (lines[i + 2] || "").trim().toLowerCase();
      els.push({ t: "art", x, y, w, h, next: source === "next" });
      i += 3; continue;
    }
    if (line === "[position]") {
      const [x, y, w, h] = lines[i + 1].split(",").map(Number);
      const png = (v) => (/\.png$/i.test((v || "").trim()) ? v.trim() : "");
      els.push({ t: "pos", x, y, w, h,
                 knob: png(lines[i + 2]), bar: png(lines[i + 3]), barHot: png(lines[i + 4]) });
      i += 5; continue;
    }
    if (line === "[button]") {
      const [x, y, w, h] = lines[i + 1].split(",").map(Number);
      const png = (v) => (/\.png$/i.test((v || "").trim()) ? v.trim() : "");
      els.push({ t: "btn", x, y, w, h,
                 action: (lines[i + 2] || "").trim(),
                 src: png(lines[i + 3]), hot: png(lines[i + 4]),
                 src2: png(lines[i + 5]), hot2: png(lines[i + 6]) });
      i += 7; continue;
    }
    if (line === "[line]") {
      const c = resolveColour(lines[i + 1], def);
      const [x1, y1, x2, y2] = lines[i + 2].split(",").map(Number);
      els.push({ t: "line", x: x1, y: y1, w: x2 - x1, h: Math.max(1, y2 - y1), c: c || "#888" });
      i += 3; continue;
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
        state.blobs.set(key, URL.createObjectURL(b));
        if (state.skinsReady) render();
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
    // a key the skin gives no picture for stays invisible; asking the browser to
    // load nothing would leave its broken-image frame on screen instead
    if (b.pair.normal) {
      b.el.src = b.pair.normal;
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
    ui.played.style.width = pct + "%";
    ui.knob.style.left = "calc(" + pct + "% - " + (ui.d / 2) + "px)";
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

  const box = $("wrap");
  const availW = Math.max(0, box.clientWidth - 32);
  const availH = Math.max(0, box.clientHeight - 32);
  if (availW < 80 || availH < 80) { requestAnimationFrame(render); return; }
  const k = Math.min(availW / L.w, availH / L.h);

  stage.style.width = (L.w * k) + "px";
  stage.style.height = (L.h * k) + "px";
  // the canvas is painted with the skin's own background colour, so a layout
  // without a full-size [rectangle] cannot fall back to the page colour
  const base = (skin.def.fonts.backgroundcol || {}).c;
  stage.style.background = base || "transparent";
  // build into a hidden layer and swap when it is painted: clearing the stage
  // first leaves one frame with nothing in it, which reads as a flash
  const buf = document.createElement("div");
  buf.className = "buf";
  buf.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;pointer-events:none;";
  const token = (state.renderToken = (state.renderToken || 0) + 1);
  state.buttons = [];
  state.posUI = null;
  $("status").textContent = L.w + "x" + L.h + "  " + els.length + " elements";


  for (const e of els) {
    let el = null;
    const place = (node) => {
      node.style.left = e.x * k + "px";
      node.style.top = e.y * k + "px";
      node.style.width = e.w * k + "px";
      node.style.height = e.h * k + "px";
      buf.appendChild(node);
    };

    if (e.t === "rect" || e.t === "line") {
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
      // Font size as a fraction of the label box height, calibrated by
      // comparing rendered text widths with a device screenshot at the same
      // scale: 0.85 was 5% too wide, 0.81 lands within half a percent.
      // no absolute minimum: it would break the ratio whenever the page is
      // zoomed out, because the stage shrinks while 7px does not
      const baseFont = Math.max(0.5, e.h * k * 0.81);
      el.style.fontSize = baseFont + "px";
      el.dataset.baseSize = String(baseFont);
      el.style.lineHeight = e.h * k + "px";
      el.style.textAlign =
        e.align === "right" ? "right" : e.align === "centered" ? "center" : "left";
      const raw = String(e.raw || "");
      // the placeholders themselves say what a label shows
      if (raw.includes("[currentposition]")) el.dataset.elapsed = "1";
      if (raw.includes("[length]")) el.dataset.total = "1";

    } else if (e.t === "art") {
      // a plain <img> is decoded but not painted here, so the picture is a
      // background of a div; the probe only exists to fall back on a 404
      el = document.createElement("div");
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
        el.style.backgroundSize = "contain";
        el.style.backgroundPosition = "center";
        el.style.backgroundRepeat = "no-repeat";
      }

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
          track.style.height = (e.h * k) + "px";
          el.appendChild(track);

          if (showTrack) {
            const played = document.createElement("div");
            played.style.position = "absolute";
            played.style.left = "0";
            played.style.top = "0";
            played.style.height = (e.h * k) + "px";
            played.style.width = (state.pos * 100) + "%";
            // the played piece is the same picture clipped to the elapsed width,
            // not the whole picture squeezed into it (that looked faint)
            played.style.backgroundImage = 'url("' + posImage(e.barHot || e.bar) + '")';
            played.style.backgroundSize = (e.w * k) + "px " + (e.h * k) + "px";
            played.style.backgroundPosition = "left center";
            played.style.backgroundRepeat = "no-repeat";
            el.appendChild(played);

            const knob = document.createElement("div");
            const knobSize = e.knob ? e.h * k : 0;
            if (paint(knob, e.knob, "contain")) {
              knob.style.position = "absolute";
              knob.style.top = ((mid * k) - (knobSize / 2)) + "px";
              knob.style.left = "calc(" + (state.pos * 100) + "% - " + (knobSize / 2) + "px)";
              knob.style.width = knobSize + "px";
              knob.style.height = knobSize + "px";
              el.appendChild(knob);
              state.posUI = { played, knob, d: knobSize };
            } else {
              state.posUI = { played, knob: null, d: 0 };
            }

            el.style.pointerEvents = "auto";
            el.style.cursor = "pointer";
            el.style.touchAction = "none";
            wireSeek(el);
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

function act(action, isLong) {
  const a = $("audio");

  if (isLong) {
    // holding play stops the track; every other key behaves like a tap, so it
    // falls through to the switch below instead of calling back into act()
    if (action === "playnpause") { stopPlayback(); return; }
  } else if (state.longGesture >= 0 && state.longGesture === state.pressGesture) {
    // the release that follows a held press belongs to that same gesture
    return;
  }

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

function wireButton(el, e, skin) {
  const btn = { el, e, skin, pair: null };
  let timer = null, longFired = false;

  const showHot = () => { if (btn.pair && btn.pair.hot) el.src = btn.pair.hot; };
  const showRest = () => { if (btn.pair && btn.pair.normal) el.src = btn.pair.normal; };

  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    state.gesture += 1;
    state.pressGesture = state.gesture;   // a fresh press is a fresh gesture
    longFired = false;
    showHot();
    timer = setTimeout(() => {
      timer = null;
      longFired = true;
      state.longGesture = state.pressGesture;   // this gesture already acted
      act(e.action, true);
      showRest();
    }, 450);
  });

  el.addEventListener("pointerup", (ev) => {
    ev.preventDefault();
    if (timer) { clearTimeout(timer); timer = null; }
    const wasLong = longFired || state.longGesture === state.pressGesture;
    longFired = false;
    showRest();
    if (!wasLong) act(e.action, false);
  });

  el.addEventListener("pointercancel", () => {
    if (timer) { clearTimeout(timer); timer = null; }
    longFired = false;
    showRest();
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

function wireSeek(el) {
  let dragging = false;

  const ratioAt = (ev) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return null;
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  };

  el.addEventListener("pointerdown", (ev) => {
    dragging = true;
    state.dragging = true;
    window.addEventListener("pointerup", onWindowUp, { once: true });
    state.seeking = true;
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    const r = ratioAt(ev);
    if (r !== null) { state.dragPos = r; setPos(r); seekThrottled(true); settleSeek(); }
  });

  el.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const r = ratioAt(ev);
    if (r === null) return;
    state.dragPos = r;
    setPos(r);
    seekThrottled(false);
    settleSeek();
  });

  function onWindowUp() {
    if (!dragging) return;
    dragging = false;
    state.dragging = false;
    endDrag();
  }

  const end = () => onWindowUp();

  el.addEventListener("pointerup", end);
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
  state.count = info.count || 0;
  state.playingId = typeof info.playingId === "number" ? info.playingId : -1;
  state.index = typeof info.index === "number" ? info.index : -1;   // -1: that row is gone
  state.slot = typeof info.slot === "number" ? info.slot : -1;      // where a jump starts

  const a = $("audio");
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
    if (info.replaygain && info.replaygain.present) {
      const db = info.replaygain.track || info.replaygain.album || 0;
      a.volume = Math.min(1, Math.max(0, Math.pow(10, db / 20)));
    } else {
      a.volume = 1;
    }
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
  window.addEventListener("drop", (e) => {
    e.preventDefault();
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
const ICON = {
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
  dark: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/>',
};

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
  const tip = (id, key) => { const el = $(id); if (el) el.title = t(key); };
  tip("browse-folder", "open.skin.tip");
  tip("browse-pkg", "open.pkg.tip");
  tip("add-audio", "add.audio.tip");
  tip("open-list", "open.list.tip");
  tip("clear-list", "clear.list");
  const lab = document.querySelector(".lang-label");
  if (lab) lab.textContent = t("lang.label");

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
    b.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round">' +
                  (ICON[state.theme] || ICON.auto) + "</svg>";
    const dict = I18N[state.lang] || I18N.en;
    b.title = dict["theme." + state.theme] || "";
  }
}

function wirePrefs() {
  state.lang = pickLang();
  const wantLang = new URLSearchParams(location.search).get("lang");
  if (wantLang === "zh" || wantLang === "en") state.lang = wantLang;
  state.theme = localStorage.getItem("theme") || "auto";
  const forced = new URLSearchParams(location.search).get("theme");
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
      applyLang();
      applyTheme();
    });
  }
  const tt = $("theme-toggle");
  if (tt) tt.addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    state.theme = next;
    localStorage.setItem("theme", next);
    applyTheme();
  });
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
  $("btn-play").addEventListener("click", () => act("playnpause", false));
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
    try {
      const r = await fetch(base + "skindef.txt", { cache: "no-store" });
      if (r.ok) found.push({ base, name: label });
    } catch (e) { /* not there */ }
  }
  if (!found.length) { status.textContent = tr("msg.noSkin"); return; }

  for (const { base, name } of found) {
    let text;
    try {
      text = dec16(await (await fetch(base + "skindef.txt", { cache: "no-store" })).arrayBuffer());
    } catch (e) { continue; }
    const entry = { def: parseSkindef(text), layouts: {},
                    base: base.startsWith("/") ? base : "./" + base };
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
  state.layout = (remembered && names.includes(remembered)) ? remembered : names[0];
  sel.value = state.layout;
}

// ------------------------------------------------------------------- wiring --
$("skin").addEventListener("change", (e) => { state.skin = e.target.value; fillLayouts(); render(); });
$("layout").addEventListener("change", (e) => {
  state.layout = e.target.value;
  localStorage.setItem("layout:" + state.skin, state.layout);
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
