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

/** A file split into lines (SPEC.md section 3): its break, its lines, whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line of a replacement: whether it is a context line (written as the file's own line). */
interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** One body line of a hunk or chunk: context, deletion or addition. */
interface BodyOp {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** Split body lines into the old lines O and the new lines N (SPEC.md section 5). */
function opsToON(ops: BodyOp[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx' || op.kind === 'del') O.push(op.text);
    if (op.kind === 'ctx' || op.kind === 'add') N.push({ text: op.text, ctx: op.kind === 'ctx', oIndex: op.kind === 'ctx' ? O.length - 1 : -1 });
  }
  return { O, N };
}

function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at one tier (overlaps count). */
function occurrencesAt(lines: string[], O: string[], tier: number): number[] {
  const oKeys = O.map((s) => tierKey(s, tier));
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== oKeys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with every occurrence (SPEC.md section 5). */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, O, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findTierFrom(
  lines: string[],
  O: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, O, tier).filter((p) => p >= from && (!eofOnly || p + O.length === lines.length));
    if (positions.length > 0) return { tier, pos: positions[0]! };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierKey(lines[i]!, tier) === tierKey(anchor, tier)) return i;
    }
  }
  return null;
}

/** Replace O at pos by N: context lines come from the file, tier 2 re-indents the rest. */
function replaceAt(lines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  if (O.length === 0) {
    for (const nl of N) out.push(nl.text);
  } else {
    const F = leadingWs(lines[pos]!);
    const P = leadingWs(O[0]!);
    for (const nl of N) {
      if (nl.ctx) out.push(lines[pos + nl.oIndex]!);
      else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(P)) out.push(F + nl.text.slice(P.length));
      else out.push(nl.text);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
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

/** One hunk of a unified diff section (SPEC.md section 6). */
interface Hunk {
  a: number;
  ops: BodyOp[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
  hasPlus: boolean;
}

/** One section of a unified diff: one edit. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `---`/`+++` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

/** Collect one hunk body starting at `start` (the line after the header). */
function collectHunkBody(lines: string[], start: number): { ops: BodyOp[]; noEol: boolean; plusNoEol: boolean; hasPlus: boolean; end: number } {
  const raw: { kind: ' ' | '-' | '+' | '\\'; text: string }[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      raw.push({ kind: (l === '' ? ' ' : l[0]) as ' ' | '-' | '+' | '\\', text: l === '' ? '' : l.slice(1) });
      i += 1;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === ' ' && last.text === '') raw.pop();
    else break;
  }
  const fixed: BodyOp[] = raw
    .filter((r) => r.kind !== '\\')
    .map((r) => ({ kind: r.kind === ' ' ? 'ctx' : r.kind === '-' ? 'del' : 'add', text: r.text }) as BodyOp);
  let noEol = false;
  let plusNoEol = false;
  let hasPlus = false;
  let lastCtxPlus = -1;
  let lastPlus = -1;
  raw.forEach((r, idx) => {
    if (r.kind === ' ' || r.kind === '+') lastCtxPlus = idx;
    if (r.kind === '+') {
      lastPlus = idx;
      hasPlus = true;
    }
  });
  if (lastCtxPlus >= 0 && raw[lastCtxPlus + 1]?.kind === '\\') noEol = true;
  if (lastPlus >= 0 && raw[lastPlus + 1]?.kind === '\\') plusNoEol = true;
  return { ops: fixed, noEol, plusNoEol, hasPlus, end: i };
}

/** Parse a unified diff into its sections (SPEC.md section 6). */
function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let i = 0;
  let cur: UniSection | null = null;
  let seenHunk = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  const finish = (): void => {
    if (cur !== null) {
      // A header-only section (a `diff --git` line whose `--- `/`+++ ` pair starts the
      // real section) carries no edit of its own.
      if (cur.hunks.length > 0 || cur.isCreate || cur.isDelete) {
        if (renameFrom !== null && cur.oldPath === null) cur.oldPath = renameFrom;
        if (renameTo !== null && cur.newPath === null) cur.newPath = renameTo;
        sections.push(cur);
      }
    }
    cur = null;
    seenHunk = false;
    renameFrom = null;
    renameTo = null;
  };
  const startDiffGit = (line: string, idx: number): void => {
    const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    finish();
    cur = { oldPath: stripAB(m[1]!), newPath: stripAB(m[2]!), isCreate: false, isDelete: false, hunks: [] };
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      startDiffGit(l, i);
      i += 1;
      continue;
    }
    // A `--- ` line followed by a `+++ ` line is the header pair of the current
    // section when it has no hunk yet, and the start of a new section otherwise.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !seenHunk) {
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      finish();
      cur = { oldPath: headerPath(l), newPath: headerPath(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] };
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = collectHunkBody(lines, i + 1);
      cur.hunks.push({ a, ops: body.ops, noEol: body.noEol, plusNoEol: body.plusNoEol, hasPlus: body.hasPlus });
      seenHunk = true;
      i = body.end;
      continue;
    }
    if (!seenHunk && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (!seenHunk && l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (!seenHunk && l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (!seenHunk && l.startsWith('new file mode')) {
      cur.isCreate = true;
      i += 1;
      continue;
    }
    if (!seenHunk && l.startsWith('deleted file mode')) {
      cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finish();
  return sections;
}

/** Apply one section's hunks to a file's lines (SPEC.md section 6). */
function applyHunks(
  lines: string[],
  br: string,
  finalIn: boolean,
  hunks: Hunk[],
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean } {
  let out = lines;
  let final = finalIn;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = opsToON(h.ops);
    if (O.length === 0) {
      const ins = Math.min(h.a + d, out.length);
      const touchedEof = ins === out.length;
      out = replaceAt(out, ins, O, N, 0);
      if (touchedEof) final = !h.noEol;
    } else {
      const found = findTier(out, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchedEof = best + O.length === out.length;
      out = replaceAt(out, best, O, N, found.tier);
      if (touchedEof) final = !h.noEol;
    }
    d += N.length - O.length;
  }
  return { lines: out, final };
}

/** One unified section as an edit. */
function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isCreate || oldP === null) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let plusNoEol = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
        if (h.hasPlus) plusNoEol = h.plusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
      return;
    }
    if (sec.isDelete || newP === null) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const { lines, br, final } = splitFile(before);
      const res = applyHunks(lines, br, final, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(res.lines, br, res.final));
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    const p = oldP;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const { lines, br, final } = splitFile(before);
    const res = applyHunks(lines, br, final, sec.hunks, strict, p);
    tree.now.set(p, joinFile(res.lines, br, res.final));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SRBlock {
  path: string | null;
  old: string[];
  newLines: string[];
  searchLine: number;
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let lastPath: string | null = null;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trim() === '' || l.trim().startsWith('```')) {
      i += 1;
      continue;
    }
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      let eq = -1;
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        j += 1;
      }
      if (eq === -1) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      j = eq + 1;
      while (j < lines.length) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
        j += 1;
      }
      if (end === -1) throw new Exit2(`error: parse ${i + 1}`);
      if (blocks.length === 0 && lastPath === null) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path: lastPath ?? blocks[blocks.length - 1]!.path, old: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end), searchLine: i });
      lastPath = null;
      i = end + 1;
      continue;
    }
    lastPath = l.trim();
    i += 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((blk) => (tree) => {
    const p = blk.path!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (blk.old.length === 0) {
      if (before !== null) throw new Fail('exists', p);
      tree.now.set(p, blk.newLines.length === 0 ? '' : blk.newLines.join('\n') + '\n');
      return;
    }
    if (before === null) throw new Fail('missing', p);
    const { lines: fl, br, final } = splitFile(before);
    const found = findTier(fl, blk.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const { O, N } = opsToON(blk.old.map((t) => ({ kind: 'del' as const, text: t })).concat(blk.newLines.map((t) => ({ kind: 'add' as const, text: t }))));
    const out = replaceAt(fl, found.positions[0]!, O, N, found.tier);
    tree.now.set(p, joinFile(out, br, final));
  });
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface V4Chunk {
  anchor: string | null;
  ops: BodyOp[];
  eof: boolean;
}

/** One section of a V4A patch. */
interface V4Section {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4Chunk[];
  updateLine: number;
}

function parseV4(lines: string[]): V4Section[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4Section[] = [];
  let i = first + 1;
  let cur: V4Section | null = null;
  const pushSection = (): void => {
    if (cur !== null) {
      if (cur.kind === 'update') {
        // Blank lines at the end of a section are not part of it: drop trailing
        // empty context lines from the last chunk.
        const lastChunk = cur.chunks[cur.chunks.length - 1];
        if (lastChunk !== undefined) {
          while (lastChunk.ops.length > 0) {
            const lastOp = lastChunk.ops[lastChunk.ops.length - 1]!;
            if (lastOp.kind === 'ctx' && lastOp.text === '') lastChunk.ops.pop();
            else break;
          }
        }
      }
      if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.updateLine + 1}`);
      sections.push(cur);
    }
    cur = null;
  };
  const sectionBody = (sec: V4Section): string[] => {
    // Blank lines at the end of a section are not part of it.
    const body = sec.lines.slice();
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
    return body;
  };
  while (i < last) {
    const l = lines[i]!;
    const t = l.trim();
    if (t === '') {
      if (cur === null) {
        i += 1;
        continue;
      }
      if (cur.kind === 'add') cur.lines.push('');
      else if (cur.kind === 'update') {
        // An empty line is an empty context line of the current chunk (it may
        // start the first chunk); trailing ones are stripped when the section closes.
        if (cur.chunks.length === 0) cur.chunks.push({ anchor: null, ops: [], eof: false });
        cur.chunks[cur.chunks.length - 1]!.ops.push({ kind: 'ctx', text: '' });
      }
      // A Delete File section has no lines: a blank line there is a section-end blank.
      i += 1;
      continue;
    }
    if (t.startsWith('*** Add File: ')) {
      pushSection();
      cur = { kind: 'add', path: t.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i };
      i += 1;
      continue;
    }
    if (t.startsWith('*** Delete File: ')) {
      pushSection();
      cur = { kind: 'delete', path: t.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i };
      i += 1;
      continue;
    }
    if (t.startsWith('*** Update File: ')) {
      pushSection();
      cur = { kind: 'update', path: t.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i };
      i += 1;
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'update' && cur.moveTo === null && cur.chunks.length === 0 && cur.lines.length === 0 && t.startsWith('*** Move to: ')) {
      cur.moveTo = t.slice('*** Move to: '.length).trim();
      i += 1;
      continue;
    }
    if (cur.kind === 'update') {
      // A chunk starts at an `@@` line, or at a body line for the first chunk.
      if (t.startsWith('@@')) {
        const anchor = t.slice(2).trim();
        cur.chunks.push({ anchor: anchor === '' ? null : anchor, ops: [], eof: false });
        i += 1;
        continue;
      }
      if (t === '*** End of File') {
        if (cur.chunks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
        cur.chunks[cur.chunks.length - 1]!.eof = true;
        i += 1;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (cur.chunks.length === 0) cur.chunks.push({ anchor: null, ops: [], eof: false });
        const kind = l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add';
        cur.chunks[cur.chunks.length - 1]!.ops.push({ kind, text: l.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Add File: lines start with `+` (or are empty, handled above).
    if (cur.kind === 'add') {
      if (l.startsWith('+')) {
        cur.lines.push(l.slice(1));
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Delete File: no lines.
    throw new Exit2(`error: parse ${i + 1}`);
  }
  pushSection();
  // Trim trailing blank lines from Add sections now that they are closed.
  for (const sec of sections) {
    if (sec.kind === 'add') sec.lines = sectionBody(sec);
  }
  return sections;
}

function v4Edits(lines: string[], strict: boolean): Edit[] {
  return parseV4(lines).map((sec) => (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const { lines: fl, br, final } = splitFile(before);
    let out = fl;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const a = findAnchor(out, chunk.anchor, cursor, strict);
        if (a === null) throw new Fail('no-match', p);
        cursor = a + 1;
      }
      const { O, N } = opsToON(chunk.ops);
      if (O.length === 0) {
        const ins = chunk.eof ? out.length : cursor;
        out = replaceAt(out, ins, O, N, 0);
        cursor = ins + N.length;
      } else {
        const found = findTierFrom(out, O, cursor, strict, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        out = replaceAt(out, found.pos, O, N, found.tier);
        cursor = found.pos + N.length;
      }
    }
    const text = joinFile(out, br, final);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push({ from: p, to: sec.moveTo });
    } else {
      tree.now.set(p, text);
    }
  });
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4Edits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const movedFrom = new Set(tree.moves.map((m) => m.from));
  const movedTo = new Set(tree.moves.map((m) => m.to));
  for (const m of tree.moves) rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Deletions first, then writes, so a deleted path never blocks a created one.
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null || tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
