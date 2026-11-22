// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 5 to 8, written for this entry (SPEC.md) ----

// A file's lines, its line break, and whether it ends with one (section 3).
function fileParts(text: string): { br: string; lines: string[]; fin: boolean } {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const normAt = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));

// First tier (0, then 1, then 2; only 0 when strict) at which old lines occur
// in the file lines at or after `from`, with every occurrence position there.
function matchAt(oldLines: string[], fileLines: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const want = oldLines.map((l) => normAt(l, tier));
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k += 1) {
        if (normAt(fileLines[i + k]!, tier) !== want[k]) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Build the replacement lines for a matched occurrence at `pos` (section 5):
// a context line is written as the file's own matched line, never the patch's;
// at tier 2 every other line is re-indented from the old lines' leading
// whitespace P to the file's matched lines' leading whitespace F.
function buildReplacement(oldLines: string[], newLines: string[], ctx: (number | null)[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(oldLines[0] ?? '');
  for (let j = 0; j < newLines.length; j += 1) {
    const c = ctx[j];
    if (c !== null && c !== undefined) { out.push(fileLines[pos + c]!); continue; }
    const line = newLines[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  oldLines: string[];
  newLines: string[];
  plusLines: string[];
  ctx: (number | null)[];
  noEol: boolean;
  noEolPlus: boolean;
}

function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

function hunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') { body.push(l); j += 1; continue; }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const plusLines: string[] = [];
  const ctx: (number | null)[] = [];
  const markers: number[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b === '') { ctx.push(oldLines.length); oldLines.push(''); newLines.push(''); lastCtxPlus = k; }
    else if (b[0] === ' ') { ctx.push(oldLines.length); oldLines.push(b.slice(1)); newLines.push(b.slice(1)); lastCtxPlus = k; }
    else if (b[0] === '-') { oldLines.push(b.slice(1)); }
    else if (b[0] === '+') { ctx.push(null); newLines.push(b.slice(1)); plusLines.push(b.slice(1)); lastCtxPlus = k; lastPlus = k; }
    else { markers.push(k - 1); }
  }
  return {
    hunk: {
      a: hunkStart(lines[start]!) ?? 0,
      oldLines,
      newLines,
      plusLines,
      ctx,
      noEol: lastCtxPlus >= 0 && markers.includes(lastCtxPlus),
      noEolPlus: lastPlus >= 0 && markers.includes(lastPlus),
    },
    next: j,
  };
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function dashPath(rest: string): string | null {
  const raw = trimWs((rest.split('\t')[0] ?? ''));
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

function diffPaths(line: string): { x: string; y: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { x, y };
}

interface UniSection {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  paired: boolean;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

function applyUniHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  const cur = [...parts.lines];
  let fin = parts.fin;
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const beforeLen = cur.length;
      const at = Math.min(h.a + d, beforeLen);
      cur.splice(at, 0, ...h.newLines);
      if (h.newLines.length > 0 && at === beforeLen) fin = !h.noEol;
      d += h.newLines.length;
      continue;
    }
    const m = matchAt(h.oldLines, cur, strict, 0);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of m.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const repl = buildReplacement(h.oldLines, h.newLines, h.ctx, cur, best, m.tier);
    const toEnd = best + h.oldLines.length === cur.length;
    cur.splice(best, h.oldLines.length, ...repl);
    if (toEnd) fin = !h.noEol;
    d += h.newLines.length - h.oldLines.length;
  }
  return joinFile(cur, parts.br, fin);
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.oldP === undefined ? s.newP : s.oldP;
  const newP = s.newP === undefined ? s.oldP : s.newP;
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (newP === null) kind = 'delete';
  else if (oldP === null) kind = 'create';
  else if (s.delFlag) kind = 'delete';
  else if (s.createFlag) kind = 'create';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (typeof oldP === 'string' && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (typeof newP === 'string' && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'create') {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        plus.push(...h.plusLines);
        if (h.plusLines.length > 0) fin = !h.noEolPlus;
      }
      tree.now.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${fin ? '\n' : ''}`);
      return;
    }
    if (kind === 'delete') {
      const op = oldP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (kind === 'move') {
      const op = oldP as string;
      const np = newP as string;
      const cur0 = tree.get(op);
      if (cur0 === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const text = applyUniHunks(cur0, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
      return;
    }
    const op = oldP as string;
    const cur0 = tree.get(op);
    if (cur0 === null) throw new Fail('missing', op);
    tree.now.set(op, applyUniHunks(cur0, s.hunks, strict, op));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headed = false;
  let i = 0;
  const open = (oldP: string | null | undefined, newP: string | null | undefined, paired = false): void => {
    cur = { oldP, newP, paired, createFlag: false, delFlag: false, hunks: [] };
    sections.push(cur);
    headed = false;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const d = diffPaths(l);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      open(d.x, d.y);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        open(dashPath(l.slice(4)), dashPath(lines[i + 1]!.slice(4)), true);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!headed) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.paired) {
            open(dashPath(l.slice(4)), dashPath(lines[i + 1]!.slice(4)), true);
            i += 2;
            continue;
          }
          cur.paired = true;
          cur.oldP = dashPath(l.slice(4));
          cur.newP = dashPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) { if (!cur.paired) cur.oldP = trimWs(l.slice(12)); i += 1; continue; }
      if (l.startsWith('rename to ')) { if (!cur.paired) cur.newP = trimWs(l.slice(10)); i += 1; continue; }
      if (l.startsWith('new file mode')) { cur.createFlag = true; i += 1; continue; }
      if (l.startsWith('deleted file mode')) { cur.delFlag = true; i += 1; continue; }
      if (l.startsWith('@@')) {
        if (hunkStart(l) === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = hunkBody(lines, i);
        cur.hunks.push(r.hunk);
        headed = true;
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      open(dashPath(l.slice(4)), dashPath(lines[i + 1]!.slice(4)), true);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (hunkStart(l) === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = hunkBody(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') { sep = j; break; }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const cur0 = tree.get(p);
      if (cur0 === null) throw new Fail('missing', p);
      const parts = fileParts(cur0);
      const m = matchAt(oldLines, parts.lines, strict, 0);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const repl = buildReplacement(oldLines, newLines, newLines.map(() => null), parts.lines, m.positions[0]!, m.tier);
      const out = [...parts.lines];
      out.splice(m.positions[0]!, oldLines.length, ...repl);
      tree.now.set(p, joinFile(out, parts.br, parts.fin));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: string[];
  ctx: (number | null)[];
}

interface VRaw {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: { text: string; no: number }[];
}

function v4aEdit(r: VRaw, strict: boolean): Edit {
  if (r.kind === 'add') {
    const fileLines: string[] = [];
    for (const l of r.raw) {
      if (l.text === '') fileLines.push('');
      else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
      else throw new Exit2(`error: parse ${l.no}`);
    }
    const text = fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`;
    const p = r.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (r.kind === 'delete') {
    if (r.raw.length > 0) throw new Exit2(`error: parse ${r.raw[0]!.no}`);
    const p = r.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  let moveTo: string | undefined;
  let idx = 0;
  if (r.raw.length > 0 && r.raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = r.raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const close = (): void => { if (cur !== null) { chunks.push(cur); cur = null; } };
  for (let k = idx; k < r.raw.length; k += 1) {
    const l = r.raw[k]!;
    if (l.text.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.no}`);
      cur.eof = true;
      close();
      continue;
    }
    if (l.text.startsWith('@@')) {
      close();
      const anchor = l.text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldLines: [], newLines: [], ctx: [] };
      continue;
    }
    if (l.text === '' || l.text[0] === ' ' || l.text[0] === '-' || l.text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${l.no}`);
        cur = { anchor: null, eof: false, oldLines: [], newLines: [], ctx: [] };
      }
      if (l.text === '') { cur.ctx.push(cur.oldLines.length); cur.oldLines.push(''); cur.newLines.push(''); }
      else if (l.text[0] === ' ') { cur.ctx.push(cur.oldLines.length); cur.oldLines.push(l.text.slice(1)); cur.newLines.push(l.text.slice(1)); }
      else if (l.text[0] === '-') { cur.oldLines.push(l.text.slice(1)); }
      else { cur.ctx.push(null); cur.newLines.push(l.text.slice(1)); }
      continue;
    }
    throw new Exit2(`error: parse ${l.no}`);
  }
  close();
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${r.lineNo}`);
  const p = r.path;
  const mt = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (mt !== undefined && !safe(mt)) throw new Fail('unsafe', mt);
    const cur0 = tree.get(p);
    if (cur0 === null) throw new Fail('missing', p);
    if (mt !== undefined && tree.get(mt) !== null) throw new Fail('exists', mt);
    const parts = fileParts(cur0);
    const cur2 = [...parts.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = matchAt([ch.anchor], cur2, strict, cursor);
        if (a === null) throw new Fail('no-match', p);
        cursor = a.positions[0]! + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? cur2.length : cursor;
        cur2.splice(at, 0, ...ch.newLines);
        cursor = at + ch.newLines.length;
        continue;
      }
      const m = matchAt(ch.oldLines, cur2, strict, cursor);
      if (m === null) throw new Fail('no-match', p);
      let pos: number | null = null;
      for (const q of m.positions) {
        if (ch.eof && q + ch.oldLines.length !== cur2.length) continue;
        pos = q;
        break;
      }
      if (pos === null) throw new Fail('no-match', p);
      const repl = buildReplacement(ch.oldLines, ch.newLines, ch.ctx, cur2, pos, m.tier);
      cur2.splice(pos, ch.oldLines.length, ...repl);
      cursor = pos + repl.length;
    }
    const text = joinFile(cur2, parts.br, parts.fin);
    if (mt !== undefined) {
      tree.now.set(p, null);
      tree.now.set(mt, text);
      tree.moves.push([p, mt]);
      return;
    }
    tree.now.set(p, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const raws: VRaw[] = [];
  let cur: VRaw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) { cur = { kind: 'add', path: l.slice(14).trim(), lineNo: i + 1, raw: [] }; raws.push(cur); continue; }
    if (l.startsWith('*** Delete File: ')) { cur = { kind: 'delete', path: l.slice(17).trim(), lineNo: i + 1, raw: [] }; raws.push(cur); continue; }
    if (l.startsWith('*** Update File: ')) { cur = { kind: 'update', path: l.slice(17).trim(), lineNo: i + 1, raw: [] }; raws.push(cur); continue; }
    if (blank(l)) { if (cur !== null) cur.raw.push({ text: l, no: i + 1 }); continue; }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    cur.raw.push({ text: l, no: i + 1 });
  }
  for (const r of raws) {
    while (r.raw.length > 0 && blank(r.raw[r.raw.length - 1]!.text)) r.raw.pop();
  }
  return raws.map((r) => v4aEdit(r, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const pairs = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined);
  const movedOld = new Set(pairs.map(([o]) => o));
  const movedNew = new Set(pairs.map(([, n]) => n));
  const shown: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    shown.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [o, n] of pairs) {
    shown.push({ key: n, line: `R ${o} -> ${n}` });
    if (check) continue;
    rmSync(o, { force: true });
    mkdirSync(dirname(n), { recursive: true });
    writeFileSync(n, tree.now.get(n)!);
  }
  shown.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = shown.map((s) => s.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
