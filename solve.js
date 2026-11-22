// A faster drop-in for makefun-site 1.0.0.
//
// Written from scratch against the behaviour makefun-site's README states and its
// reference code runs: for every input, run(input) returns byte-for-byte the same
// output tree makefun-site 1.0.0's build returns. The speed comes from doing the
// same work with less of it: inline rendering that escapes whole runs of plain text
// instead of one character at a time, a Markdown reader that walks the body by
// offsets instead of splitting it into lines, front matter read without splitting
// the body, a memoised slugifier with a fast path for the ASCII text the generator
// mostly draws, and a template renderer that appends into one array instead of
// building a string per node.
//
// No dependency, no file, clock, environment or randomness read: the output is a
// function of the input alone, as the reference's is.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text` with & < > " and ' escaped. A single scan; a string holding none of them is returned as it is. */
function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (i > start) out += text.slice(start, i);
    out += rep;
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/** The slugs of one build, memoised: a slug is a pure function of its text, and tag names, titles and headings repeat. */
let slugCache = null;

/** The slug of `text`, exactly as the reference's: NFKD, combining marks dropped, A-Z lowered, every run of characters
 *  other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), and
 *  "untitled" when nothing is left. Pure ASCII text skips the normalisation: NFKD is the identity on it and it holds
 *  no combining marks. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII.test(text)) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(MARKS, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether the code unit is JavaScript whitespace (\s), exactly. */
function isWS(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII is the body's near-whole: space and \t..\r are its only whitespace there.
    const ws = c < 128 ? c === 32 || (c >= 9 && c <= 13) : isWS(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `s` holds only spaces and tabs. */
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * Only the front matter's own lines are ever cut out of the text; the body is one slice, never split and rejoined.
 * `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? text.length : nl0;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  let pos = firstEnd + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const le = e === -1 ? text.length : e;
    if (text.slice(pos, le) === '---') {
      closeStart = pos;
      closeEnd = le;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lpos = firstEnd + 1;
  let lineNo = 2;
  while (lpos < closeStart) {
    const e = text.indexOf('\n', lpos);
    const le = e === -1 || e >= closeStart ? closeStart : e;
    const line = text.slice(lpos, le);
    lpos = e === -1 || e >= closeStart ? closeStart : e + 1;
    if (isBlankStr(line) || line.charCodeAt(0) === 35) {
      lineNo++;
      continue;
    }
    const m = LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Whether the code unit may follow a backslash escape: \ ` * _ [ ] ( ) # + - . ! > */
function isEscapableCode(c) {
  return (
    c === 92 ||
    c === 96 ||
    c === 42 ||
    c === 95 ||
    c === 91 ||
    c === 93 ||
    c === 40 ||
    c === 41 ||
    c === 35 ||
    c === 43 ||
    c === 45 ||
    c === 46 ||
    c === 33 ||
    c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace character. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** The marks inline rendering stops at: backslash, backtick, star and [. The scan jumps straight to the next of
 *  them (a native scan), instead of stepping through every plain character. One shared regex: rendering is
 *  single-threaded and synchronous, and every use sets lastIndex explicitly after a nested render returns. */
const INLINE_NEXT = /[\\`*\[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain text is carried in one run and escaped whole when
 * a mark interrupts it, instead of escaping every character on its own.
 */
function inline(s, env) {
  let out = '';
  let start = 0;
  INLINE_NEXT.lastIndex = 0;
  let m;
  while ((m = INLINE_NEXT.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isEscapableCode(s.charCodeAt(i + 1))) {
      if (i > start) out += escapeHtml(s.slice(start, i));
      out += s[i + 1];
      INLINE_NEXT.lastIndex = i + 2;
      start = i + 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out += escapeHtml(s.slice(start, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        INLINE_NEXT.lastIndex = j + 1;
        start = j + 1;
      } else INLINE_NEXT.lastIndex = i + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out += escapeHtml(s.slice(start, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          INLINE_NEXT.lastIndex = j + 2;
          start = j + 2;
        } else INLINE_NEXT.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out += escapeHtml(s.slice(start, i));
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        INLINE_NEXT.lastIndex = j + 1;
        start = j + 1;
      } else INLINE_NEXT.lastIndex = i + 1;
      continue;
    }
    // c === 91, '['.
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !hasWS(target)) {
      if (i > start) out += escapeHtml(s.slice(start, i));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      INLINE_NEXT.lastIndex = mm + 1;
      start = mm + 1;
      continue;
    }
    INLINE_NEXT.lastIndex = i + 1;
  }
  if (s.length > start) out += escapeHtml(s.slice(start));
  return out;
}

// --- the block reader: lines as (start, end) offsets into the body, never split out ---

/** The end of the line starting at `pos` (the "\n", or the body's end). */
function lineEnd(src, pos) {
  const e = src.indexOf('\n', pos);
  return e === -1 ? src.length : e;
}

/** Whether the line [s, e) is blank (spaces and tabs only). */
function isBlank(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The line [s, e) with spaces and tabs dropped at both ends. */
function trimSlice(src, s, e) {
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return src.slice(s, e);
}

/** Whether `c` may open a fence's language. */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence's language when the line [s, e) opens one, else null. */
function fenceOpen(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let j = s + 3;
  while (j < e && isLangChar(src.charCodeAt(j))) j++;
  const lang = src.slice(s + 3, j);
  while (j < e && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  return j === e ? lang : null;
}

/** Whether the line [s, e) closes a fence. */
function isFenceClose(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let j = s + 3; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingInfo(src, s, e) {
  let d = 0;
  while (d < 6 && s + d < e && src.charCodeAt(s + d) === 35) d++;
  if (d === 0 || s + d >= e) return null;
  const c = src.charCodeAt(s + d);
  if (c !== 32 && c !== 9) return null;
  let t0 = s + d;
  while (t0 < e && (src.charCodeAt(t0) === 32 || src.charCodeAt(t0) === 9)) t0++;
  let t1 = e;
  while (t1 > t0 && (src.charCodeAt(t1 - 1) === 32 || src.charCodeAt(t1 - 1) === 9)) t1--;
  if (t1 === t0) return null;
  return { depth: d, text: src.slice(t0, t1) };
}

/** Whether the line [s, e) is a thematic break. */
function isHR(src, s, e) {
  if (e - s < 3) return false;
  const c0 = src.charCodeAt(s);
  const c1 = src.charCodeAt(s + 1);
  const c2 = src.charCodeAt(s + 2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let j = s + 3; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text when the line [s, e) opens one, else null. */
function bulletInfo(src, s, e) {
  if (e - s < 2) return null;
  const c = src.charCodeAt(s);
  if ((c === 45 || c === 42) && src.charCodeAt(s + 1) === 32) return trimSlice(src, s + 2, e);
  return null;
}

/** An ordered item's number and text when the line [s, e) opens one, else null. */
function orderedInfo(src, s, e) {
  let j = s;
  let digits = 0;
  while (j < e && digits < 10 && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) {
    j++;
    digits++;
  }
  if (digits === 0 || digits > 9) return null;
  if (j + 1 >= e || src.charCodeAt(j) !== 46 || src.charCodeAt(j + 1) !== 32) return null;
  return { num: src.slice(s, j), text: trimSlice(src, j + 2, e) };
}

/** Whether the line [s, e) continues a list item: two or more spaces, then a non-space. */
function isContinued(src, s, e) {
  let sp = 0;
  while (s + sp < e && src.charCodeAt(s + sp) === 32) sp++;
  if (sp < 2 || s + sp >= e) return false;
  return !isWS(src.charCodeAt(s + sp));
}

/** Whether the line [s, e) ends a paragraph: a blank line, a fence, a heading or a thematic break. Only a line
 *  opening on a space or tab can be blank, only one opening on a backtick a fence, only one opening on # a heading,
 *  and only one opening on - or * a break, so the first code unit picks the one check that can answer. */
function endsParagraph(src, s, e) {
  if (s >= e) return true;
  const c = src.charCodeAt(s);
  if (c === 32 || c === 9) return isBlank(src, s, e);
  if (c === 96) return fenceOpen(src, s, e) !== null;
  if (c === 35) return headingInfo(src, s, e) !== null;
  if (c === 45 || c === 42) return isHR(src, s, e);
  return false;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let end = lineEnd(src, pos);
    if (end === pos) {
      // An empty line is blank.
      pos = end + 1;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    // A line opening on a space or tab is a blank line or a paragraph line; nothing else can open on one.
    if (c0 === 32 || c0 === 9) {
      if (isBlank(src, pos, end)) {
        pos = end + 1;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(src, pos, end);
      if (lang !== null) {
        let code = `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
        pos = end + 1;
        while (pos < n) {
          end = lineEnd(src, pos);
          if (isFenceClose(src, pos, end)) {
            pos = end + 1;
            break;
          }
          code += `${escapeHtml(src.slice(pos, end))}\n`;
          pos = end + 1;
        }
        html += `${code}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingInfo(src, pos, end);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const hhtml = inline(hd.text, env);
        html += `<h${hd.depth} id="${id}">${hhtml}</h${hd.depth}>\n`;
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: hhtml });
        pos = end + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(src, pos, end)) {
        html += '<hr>\n';
        pos = end + 1;
        continue;
      }
      const firstBullet = bulletInfo(src, pos, end);
      if (firstBullet !== null) {
        const items = [];
        while (pos < n) {
          end = lineEnd(src, pos);
          const it = bulletInfo(src, pos, end);
          if (it !== null) {
            items.push([it]);
            pos = end + 1;
          } else if (isContinued(src, pos, end)) {
            items[items.length - 1].push(trimSlice(src, pos, end));
            pos = end + 1;
          } else break;
        }
        let listHtml = '<ul>\n';
        for (const parts of items) listHtml += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        html += `${listHtml}</ul>\n`;
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      while (pos < n) {
        end = lineEnd(src, pos);
        if (src.charCodeAt(pos) !== 62) break;
        let s2 = pos + 1;
        if (s2 < end && src.charCodeAt(s2) === 32) s2++;
        const t = trimSlice(src, s2, end);
        if (t !== '') qlines.push(t);
        pos = end + 1;
      }
      html += qlines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(qlines.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const firstOrdered = orderedInfo(src, pos, end);
      if (firstOrdered !== null) {
        const start = Number(firstOrdered.num);
        const items = [];
        while (pos < n) {
          end = lineEnd(src, pos);
          const om = orderedInfo(src, pos, end);
          if (om !== null) {
            items.push([om.text]);
            pos = end + 1;
          } else if (isContinued(src, pos, end)) {
            items[items.length - 1].push(trimSlice(src, pos, end));
            pos = end + 1;
          } else break;
        }
        let listHtml = start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (const parts of items) listHtml += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        html += `${listHtml}</ol>\n`;
        continue;
      }
    }
    let text = trimSlice(src, pos, end);
    pos = end + 1;
    while (pos < n) {
      end = lineEnd(src, pos);
      if (endsParagraph(src, pos, end)) break;
      text += `\n${trimSlice(src, pos, end)}`;
      pos = end + 1;
    }
    const phtml = inline(text, env);
    if (excerpt === null) excerpt = phtml;
    html += `<p>${phtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankStr(src.slice(lineStart, open)) && isBlankStr(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. `ctx` holds the parsed templates and the
 * include depth. Loops use a plain for loop and a fresh scope per element; includes render in the same scope.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') {
      out.push(n.text);
      continue;
    }
    if (n.kind === 'var') {
      out.push(escapeHtml(textOf(lookup(scope, n.path))));
      continue;
    }
    if (n.kind === 'raw') {
      out.push(textOf(lookup(scope, n.path)));
      continue;
    }
    if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
      continue;
    }
    if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
      }
      continue;
    }
    const t = ctx.templates.get(n.name);
    if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. A post reuses its card: cardOf is pure, so the values are the same. */
function pageOf(b, s) {
  const card = s.post ? b.cards.get(s) : cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  slugCache = null;
  return b.output;
}
