// A subset of foobar2000 title formatting, enough for skin labels.
//
// Scripts are parsed once and cached. Values carry a truth flag as well as a
// string, because $if and friends test truthiness rather than text: a field
// reference is true when the field is present, a plain string is always false.
//
// The rules follow the title formatting reference: no whitespace between $ and
// the function name, ' quotes escape %, $, [, ] and ', '' is one quote, and
// [... ] is a conditional section.
"use strict";

window.TF = (function () {
  const parsed = new Map();

  // ---------------------------------------------------------------- parsing --
  function parse(src) {
    if (parsed.has(src)) return parsed.get(src);
    let i = 0;

    function seq(stop) {
      const out = [];
      let buf = "";
      const flush = () => {
        if (buf) { out.push({ t: "lit", v: buf }); buf = ""; }
      };
      while (i < src.length) {
        const ch = src[i];
        if (stop && stop.includes(ch)) break;

        if (ch === "'") {
          if (src[i + 1] === "'") { buf += "'"; i += 2; continue; }
          let text = "";
          i++;
          while (i < src.length) {
            if (src[i] === "'") {
              if (src[i + 1] === "'") { text += "'"; i += 2; continue; }
              i++; break;
            }
            text += src[i++];
          }
          buf += text;
          continue;
        }

        if (ch === "[") {
          flush();
          i++;
          const body = seq("]");
          if (src[i] === "]") i++;
          out.push({ t: "cond", body });
          continue;
        }

        if (ch === "%") {
          const end = src.indexOf("%", i + 1);
          if (end > i) {
            flush();
            out.push({ t: "field", n: src.slice(i + 1, end).toLowerCase() });
            i = end + 1;
            continue;
          }
        }

        if (ch === "$") {
          let j = i + 1;
          let name = "";
          while (j < src.length && /[A-Za-z0-9_#]/.test(src[j])) name += src[j++];
          if (name && src[j] === "(") {
            flush();
            i = j + 1;
            const args = [];
            while (i < src.length) {
              args.push(seq(",)"));               // parse until a separator
              if (src[i] === ",") { i++; continue; }
              break;
            }
            if (src[i] === ")") i++;
            out.push({ t: "fn", n: name.toLowerCase(), args });
            continue;
          }
          if (name === "" && src[i + 1] === "$") { buf += "$"; i += 2; continue; }
        }

        buf += ch;
        i++;
      }
      flush();
      return out;
    }

    const nodes = seq("");
    parsed.set(src, nodes);
    return nodes;
  }

  // ------------------------------------------------------------- evaluation --
  function num(s) {
    const m = /^\s*(-?\d+)/.exec(String(s));
    return m ? parseInt(m[1], 10) : 0;
  }

  const plain = (s) => ({ s: String(s), b: false });
  const truth = (b, s) => ({ s: s === undefined ? "" : String(s), b: !!b });

  function width(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
                   (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
                   (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
                   (c >= 0x1f300 && c <= 0x1f9ff);
      n += wide ? 2 : 1;
    }
    return n;
  }

  const year_of = (s) => {
    const m = /(\d{4})/.exec(String(s));
    return m ? m[1] : "";
  };

  // Each function receives (arg, ctx) where arg(i) evaluates lazily, so $if and
  // friends never touch the branch they do not take.
  const FN = {
    if: (a) => (a(0).b ? a(1) : (a.count > 2 ? a(2) : truth(false))),
    if2: (a) => (a(0).b ? a(0) : a(1)),
    if3: (a) => {
      for (let i = 0; i < a.count - 1; i++) {
        const v = a(i);
        if (v.b) return v;
      }
      return a(a.count - 1);
    },
    ifequal: (a) => (num(a(0).s) === num(a(1).s) ? a(2) : a(3)),
    ifgreater: (a) => (num(a(0).s) > num(a(1).s) ? a(2) : a(3)),
    iflonger: (a) => (a(0).s.length > num(a(1).s) ? a(2) : a(3)),

    or: (a) => {
      let any = false;
      for (let i = 0; i < a.count; i++) if (a(i).b) any = true;
      return truth(any);
    },
    and: (a) => {
      let all = true;
      for (let i = 0; i < a.count; i++) if (!a(i).b) all = false;
      return truth(all);
    },
    not: (a) => truth(!a(0).b),
    xor: (a) => {
      let odd = false;
      for (let i = 0; i < a.count; i++) if (a(i).b) odd = !odd;
      return truth(odd);
    },

    add: (a) => sum(a, (x, y) => x + y),
    sub: (a) => sum(a, (x, y) => x - y),
    mul: (a) => sum(a, (x, y) => x * y),
    div: (a) => sum(a, (x, y) => (y === 0 ? x : Math.floor(x / y))),
    mod: (a) => sum(a, (x, y) => (y === 0 ? x : x % y)),
    max: (a) => sum(a, Math.max),
    min: (a) => sum(a, Math.min),

    len: (a) => { const v = a(0); return truth(v.b, String(v.s).length); },
    len2: (a) => { const v = a(0); return truth(v.b, width(v.s)); },
    upper: (a) => { const v = a(0); return truth(v.b, v.s.toUpperCase()); },
    lower: (a) => { const v = a(0); return truth(v.b, v.s.toLowerCase()); },
    caps: (a) => {
      const v = a(0);
      const s = v.s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      return truth(v.b, s);
    },
    trim: (a) => { const v = a(0); return truth(v.b, v.s.trim()); },
    left: (a) => { const v = a(0), n = num(a(1).s); return truth(v.b, n < 0 ? v.s : v.s.slice(0, n)); },
    right: (a) => { const v = a(0), n = num(a(1).s); return truth(v.b, n <= 0 ? v.s : v.s.slice(-n)); },
    insert: (a) => {
      const v = a(0), ins = a(1).s, n = num(a(2).s);
      return truth(v.b, v.s.slice(0, n) + ins + v.s.slice(n));
    },
    strchr: (a) => {
      const p = a(0).s.indexOf(a(1).s);
      return truth(p >= 0, p + 1);
    },
    strcmp: (a) => truth(a(0).s === a(1).s),
    stricmp: (a) => truth(a(0).s.toLowerCase() === a(1).s.toLowerCase()),
    replace: (a) => {
      const src = a(0).s;
      const pairs = [];
      for (let i = 1; i + 1 < a.count; i += 2) pairs.push([a(i).s, a(i + 1).s]);
      let out = "";
      let i = 0;
      while (i < src.length) {
        let hit = null;
        for (const [find, rep] of pairs) {
          if (find && src.startsWith(find, i)) { hit = [find, rep]; break; }
        }
        if (hit) { out += hit[1]; i += hit[0].length; }
        else out += src[i++];
      }
      return truth(a(0).b, out);
    },
    num: (a) => truth(a(0).b, String(num(a(0).s)).padStart(Math.max(0, num(a(1).s)), "0")),
    year: (a) => { const v = a(0); return truth(v.b, year_of(v.s)); },
    directory_path: (a) => {
      const v = a(0);
      const p = v.s.replace(/\\/g, "/");
      const cut = p.lastIndexOf("/");
      return truth(v.b, cut > 0 ? v.s.slice(0, cut) : "");
    },
    abbr: (a) => {
      const v = a(0);
      if (a.count > 1) {
        const n = num(a(1).s);
        return truth(v.b, v.s.length > n ? v.s : v.s);
      }
      const out = v.s.split(/\s+/).filter(Boolean)
        .map((w) => (/[0-9A-Za-z]/.test(w[0]) ? w[0] : ""))
        .join("");
      return truth(v.b, out);
    },
    char: (a) => truth(true, String.fromCodePoint(num(a(0).s) || 32)),
    hex: (a) => truth(a(0).b, num(a(0).s).toString(16).toUpperCase()
                        .padStart(Math.max(0, num(a(1).s)), "0")),
    repeat: (a) => truth(a(0).b, a(0).s.repeat(Math.max(0, num(a(1).s)))),
    longer: (a) => truth(a(0).s.length > a(1).s.length),
    substr: (a) => {
      const v = a(0), from = Math.max(1, num(a(1).s)), to = num(a(2).s);
      return truth(v.b, v.s.slice(from - 1, to > 0 ? to : undefined));
    },
    strstr: (a) => { const p = a(0).s.indexOf(a(1).s); return truth(p >= 0, p + 1); },
    strrchr: (a) => { const p = a(0).s.lastIndexOf(a(1).s); return truth(p >= 0, p + 1); },
    select: (a) => {
      const n = num(a(0).s);
      return (n >= 1 && n < a.count) ? a(n) : truth(false);
    },
    greater: (a) => truth(num(a(0).s) > num(a(1).s)),
    less: (a) => truth(num(a(0).s) < num(a(1).s)),
    mod_: (a) => truth(a(0).b, a(0).s),
    pad: (a) => {
      const v = a(0), n = num(a(1).s), c = a.count > 2 ? a(2).s : " ";
      return truth(v.b, v.s.length >= n ? v.s : v.s + c.repeat(n - v.s.length).slice(0, n - v.s.length));
    },
    pad_right: (a) => {
      const v = a(0), n = num(a(1).s), c = a.count > 2 ? a(2).s : " ";
      return truth(v.b, v.s.length >= n ? v.s : c.repeat(n - v.s.length).slice(0, n - v.s.length) + v.s);
    },
    cut: (a) => FN.left(a),
    eq: (a) => truth(num(a(0).s) === num(a(1).s)),
    ne: (a) => truth(num(a(0).s) !== num(a(1).s)),
    gt: (a) => truth(num(a(0).s) > num(a(1).s)),
    gte: (a) => truth(num(a(0).s) >= num(a(1).s)),
    lt: (a) => truth(num(a(0).s) < num(a(1).s)),
    lte: (a) => truth(num(a(0).s) <= num(a(1).s)),
    crlf: () => truth(true, "\r\n"),
    tab: (a) => truth(true, a.count ? "\t".repeat(Math.min(256, Math.max(0, num(a(0).s)))) : "\t"),
    noop: () => truth(false),
    firstalphachar: (a) => {
      const v = a(0);
      const fallback = a.count > 1 ? a(1).s : "#";
      const first = [...v.s][0];
      return truth(v.b, first && /\p{L}/u.test(first) ? first : fallback);
    },
    stripprefix: (a) => {
      const v = a(0);
      const prefixes = a.count > 1
        ? Array.from({ length: a.count - 1 }, (_, i) => a(i + 1).s)
        : ["A ", "The "];
      let s = v.s;
      for (const p of prefixes) {
        if (p && s.toLowerCase().startsWith(p.toLowerCase())) { s = s.slice(p.length); break; }
      }
      return truth(v.b, s);
    },
    swapprefix: (a) => {
      const v = a(0);
      const prefixes = a.count > 1
        ? Array.from({ length: a.count - 1 }, (_, i) => a(i + 1).s)
        : ["A ", "The "];
      let s = v.s;
      for (const p of prefixes) {
        if (p && s.toLowerCase().startsWith(p.toLowerCase())) {
          s = s.slice(p.length) + ", " + p.trim();
          break;
        }
      }
      return truth(v.b, s);
    },
    date: (a) => { const v = a(0); const m = /(\d{4})-(\d{2})-(\d{2})/.exec(v.s); return truth(v.b, m ? m[0] : ""); },
    month: (a) => { const v = a(0); const m = /(\d{4})-(\d{2})/.exec(v.s); return truth(v.b, m ? m[2] : ""); },
    day_of_month: (a) => { const v = a(0); const m = /\d{4}-\d{2}-(\d{2})/.exec(v.s); return truth(v.b, m ? m[1] : ""); },
    time: (a) => { const v = a(0); const m = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(v.s); return truth(v.b, m ? m[1] : ""); },
    fix_eol: (a) => {
      const v = a(0);
      const cut = v.s.search(/\r?\n/);
      const mark = a.count > 1 ? a(1).s : " (...)";
      return truth(v.b, cut < 0 ? v.s : v.s.slice(0, cut) + mark);
    },
    ascii: (a) => { const v = a(0); return truth(v.b, v.s.replace(/[^\x00-\x7f]/g, "")); },
    rot13: (a) => {
      const v = a(0);
      return truth(v.b, v.s.replace(/[A-Za-z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
      }));
    },
    meta_sep: (a) => FN.meta(a),
    meta_num: (a) => truth(true, a.fields[String(a(0).s).toLowerCase()] ? "1" : "0"),
    meta_test: (a) => {
      for (let i = 0; i < a.count; i++) {
        const v = a.fields[String(a(i).s).toLowerCase()];
        if (v === undefined || v === "") return truth(false);
      }
      return truth(true);
    },
    meta: (a) => {
      const name = String(a(0).s).toLowerCase();
      const v = a.fields[name];
      return truth(v !== undefined && v !== "", v === undefined ? "" : v);
    },
    info: (a) => {
      const name = "__" + String(a(0).s).toLowerCase();
      const v = a.fields[name];
      return truth(v !== undefined && v !== "", v === undefined ? "" : v);
    },
    get: (a) => {
      const v = a.vars[String(a(0).s).toLowerCase()];
      return truth(v !== undefined && v !== "", v === undefined ? "" : v);
    },
    put: (a) => {
      const v = a(1);
      a.vars[String(a(0).s).toLowerCase()] = v.s;
      return v;
    },
    puts: (a) => {
      a.vars[String(a(0).s).toLowerCase()] = a(1).s;
      return truth(false);
    },
  };

  function sum(a, op) {
    let acc = num(a(0).s);
    let ok = a(0).b;
    for (let i = 1; i < a.count; i++) {
      const v = a(i);
      ok = ok && v.b;
      acc = op(acc, num(v.s));
    }
    return truth(ok, acc);
  }

  function evalNodes(nodes, ctx) {
    let s = "";
    let b = false;
    for (const node of nodes) {
      if (node.t === "lit") { s += node.v; continue; }
      if (node.t === "field") {
        const v = ctx.fields[node.n];
        if (v !== undefined && v !== "") { s += v; b = true; }
        continue;
      }
      if (node.t === "cond") {
        const inner = evalNodes(node.body, ctx);
        if (inner.b) { s += inner.s; b = true; }
        continue;
      }
      const fn = FN[node.n];
      if (!fn) continue;                     // unknown function: drop it, as the app does
      const arg = (i) => (i < node.args.length ? evalNodes(node.args[i], ctx) : plain(""));
      arg.count = node.args.length;
      arg.fields = ctx.fields;
      arg.vars = ctx.vars;
      const v = fn(arg);
      if (v.b) b = true;
      s += v.s;
    }
    return { s, b };
  }

  function format(script, fields, vars) {
    try {
      return evalNodes(parse(String(script)), { fields: fields || {}, vars: vars || {} }).s;
    } catch (e) {
      return String(script);                 // never break the label over a script
    }
  }

  return { format };
})();
