// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none.
// SPEC.md is the whole contract; this file implements it end to end on
// Node 22 and its standard library alone. Run it as:
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse fault: exit 2 with `error: parse <line>`. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>`. */
class FailErr {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** Shared state for one run: the matching mode and the moves that landed. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

/** One edit: apply it to the tree or throw a FailErr, changing nothing. */
type Edit = (tree: Tree) => void;

/** A file as lines, with its own line break and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A patch's lines: split at `\n`, one trailing `\r` removed from each. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** The tree as the edits leave it: changed paths in `now`, the rest on disk. */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  orig(p: string): string | null {
    if (!this.seen.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.seen.set(p, value);
    }
    return this.seen.get(p) ?? null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p) ?? null : this.orig(p);
  }

  set(p: string, value: string | null): void {
    this.now.set(p, value);
  }
}

// ---------------------------------------------------------------------------
// Matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Positions where `old` occurs in `file` at `tier`, from `from` on. */
function occurrences(
  file: string[],
  old: string[],
  tier: number,
  from: number,
  eofOnly: boolean,
): number[] {
  const out: number[] = [];
  const k = old.length;
  if (k === 0) return out;
  for (let i = from; i + k <= file.length; i++) {
    if (eofOnly && i + k !== file.length) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** The first tier at which `old` occurs at or after `from`, and where. */
function findTier(
  file: string[],
  old: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(file, old, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewPart {
  text: string;
  /** Index into O for a context line, null for a fresh line. */
  ctx: number | null;
}

/**
 * The lines N writes in place of the matched ones. A context line is the
 * file's own matched line; at tier 2 every other line is re-indented from
 * O's first line to the file's first matched line.
 */
function buildNew(
  file: string[],
  at: number,
  old: string[],
  parts: NewPart[],
  tier: number,
): string[] {
  const out: string[] = [];
  const fLead = leadOf(file[at] ?? '');
  const pLead = leadOf(old[0] ?? '');
  for (const part of parts) {
    if (part.ctx !== null) {
      out.push(file[at + part.ctx] ?? part.text);
      continue;
    }
    const t = part.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(pLead)) {
      out.push(fLead + t.slice(pLead.length));
    } else {
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: string;
  text: string;
  /** The raw patch line was exactly empty. */
  empty: boolean;
}

interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@`. */
  start: number;
  body: HunkLine[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, to the first tab. */
function headerPath(line: string): string {
  const cut = line.slice(4).split('\t', 1)[0] ?? '';
  let p = cut.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') {
      return k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** True when a `\` line follows the section's last `+` line, over all hunks. */
function createNoEol(sec: UniSection): boolean {
  for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
    const body = sec.hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === '+') {
        return k + 1 < body.length && body[k + 1]!.kind === '\\';
      }
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(doc: FileDoc, hunks: Hunk[], ctx: Ctx, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oldLines: string[] = [];
    const newParts: NewPart[] = [];
    let oPos = 0;
    for (const b of h.body) {
      if (b.kind === ' ') {
        oldLines.push(b.text);
        newParts.push({ text: b.text, ctx: oPos });
        oPos++;
      } else if (b.kind === '-') {
        oldLines.push(b.text);
        oPos++;
      } else if (b.kind === '+') {
        newParts.push({ text: b.text, ctx: null });
      }
    }
    const noEol = hunkNoEol(h);
    if (oldLines.length === 0) {
      let at = h.start + d;
      if (at < 0) at = 0;
      if (at > doc.lines.length) at = doc.lines.length;
      const atEnd = at === doc.lines.length;
      const made = buildNew(doc.lines, at, oldLines, newParts, 0);
      doc.lines.splice(at, 0, ...made);
      if (atEnd) doc.final = !noEol;
      d += newParts.length;
      continue;
    }
    const found = findTier(doc.lines, oldLines, 0, ctx.strict, false);
    if (found === null) throw new FailErr('no-match', path);
    const want = h.start - 1 + d;
    let at = found.positions[0]!;
    let best = Math.abs(at - want);
    for (const p of found.positions) {
      const dist = Math.abs(p - want);
      if (dist < best) {
        at = p;
        best = dist;
      }
    }
    const atEnd = at + oldLines.length === doc.lines.length;
    const made = buildNew(doc.lines, at, oldLines, newParts, found.tier);
    doc.lines.splice(at, oldLines.length, ...made);
    if (atEnd) doc.final = !noEol;
    d += newParts.length - oldLines.length;
  }
}

function uniSectionEdit(sec: UniSection, ctx: Ctx): Edit {
  const oldRaw = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newRaw = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const oldNull = oldRaw === '/dev/null';
  const newNull = newRaw === '/dev/null';
  const oldPath = oldNull ? null : oldRaw ?? null;
  const newPath = newNull ? null : newRaw ?? null;
  const creating = oldNull || sec.newFile;
  const deleting = !creating && (newNull || sec.deletedFile);

  if (creating) {
    const target = newPath ?? '';
    return (tree) => {
      if (!safePath(target)) throw new FailErr('unsafe', target);
      if (tree.get(target) !== null) throw new FailErr('exists', target);
      const made: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') made.push(b.text);
      }
      tree.set(target, writeDoc({ lines: made, br: '\n', final: !createNoEol(sec) }));
    };
  }
  if (deleting) {
    const target = oldPath ?? '';
    return (tree) => {
      if (!safePath(target)) throw new FailErr('unsafe', target);
      if (tree.get(target) === null) throw new FailErr('missing', target);
      tree.set(target, null);
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return (tree) => {
      if (!safePath(oldPath)) throw new FailErr('unsafe', oldPath);
      if (!safePath(newPath)) throw new FailErr('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new FailErr('missing', oldPath);
      if (tree.get(newPath) !== null) throw new FailErr('exists', newPath);
      const doc = parseDoc(cur);
      applyHunks(doc, sec.hunks, ctx, oldPath);
      tree.set(newPath, writeDoc(doc));
      tree.set(oldPath, null);
      ctx.moves.push([oldPath, newPath]);
    };
  }
  const target = oldPath ?? '';
  return (tree) => {
    if (!safePath(target)) throw new FailErr('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new FailErr('missing', target);
    const doc = parseDoc(cur);
    applyHunks(doc, sec.hunks, ctx, target);
    tree.set(target, writeDoc(doc));
  };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+?) b\/(.+)$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      cur = {
        pairOld: null,
        pairNew: null,
        renameFrom: null,
        renameTo: null,
        diffOld: m[1]!.trim(),
        diffNew: m[2]!.trim(),
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      curHunk = null;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader && cur.pairOld === null) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
      } else {
        cur = {
          pairOld: oldP,
          pairNew: newP,
          renameFrom: null,
          renameTo: null,
          diffOld: null,
          diffNew: null,
          newFile: false,
          deletedFile: false,
          hunks: [],
        };
        sections.push(cur);
        curHunk = null;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      if (cur === null) throw new ParseErr(i + 1);
      curHunk = { start: Number(m[1]), body: [] };
      cur.hunks.push(curHunk);
      inHeader = false;
      i++;
      continue;
    }
    if (curHunk !== null) {
      if (
        line === '' ||
        line[0] === ' ' ||
        line[0] === '-' ||
        line[0] === '+' ||
        line[0] === '\\'
      ) {
        curHunk.body.push({
          kind: line === '' ? ' ' : line[0]!,
          text: line === '' ? '' : line.slice(1),
          empty: line === '',
        });
        i++;
        continue;
      }
      curHunk = null;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1]!.empty) h.body.pop();
    }
  }
  return sections.map((s) => uniSectionEdit(s, ctx));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function makeSearchReplaceEdit(
  path: string,
  oldLines: string[],
  newLines: string[],
  ctx: Ctx,
): Edit {
  return (tree) => {
    if (!safePath(path)) throw new FailErr('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new FailErr('exists', path);
      tree.set(path, writeDoc({ lines: newLines, br: '\n', final: true }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new FailErr('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, 0, ctx.strict, false);
    if (found === null) throw new FailErr('no-match', path);
    if (found.positions.length > 1) throw new FailErr('ambiguous', path);
    const at = found.positions[0]!;
    const parts = newLines.map((t) => ({ text: t, ctx: null as number | null }));
    const made = buildNew(doc.lines, at, oldLines, parts, found.tier);
    doc.lines.splice(at, oldLines.length, ...made);
    tree.set(path, writeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(searchLine);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      // A REPLACE line before any ======= means the block never had one:
      // the fault section 7 names, reported at the SEARCH line.
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(searchLine);
    edits.push(
      makeSearchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), ctx),
    );
    prevPath = path;
    prevEnd = rep;
    i = rep;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: string; text: string }>;
}

interface VSectionRaw {
  kind: string;
  path: string;
  pathLine: number;
  raw: Array<{ text: string; num: number }>;
}

function vSectionEdit(sec: VSectionRaw, ctx: Ctx): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const rl of sec.raw) {
      if (rl.text === '') fileLines.push('');
      else if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
      else throw new ParseErr(rl.num);
    }
    const path = sec.path;
    return (tree) => {
      if (!safePath(path)) throw new FailErr('unsafe', path);
      if (tree.get(path) !== null) throw new FailErr('exists', path);
      tree.set(path, writeDoc({ lines: fileLines, br: '\n', final: true }));
    };
  }
  if (sec.kind === 'delete') {
    if (sec.raw.length > 0) throw new ParseErr(sec.raw[0]!.num);
    const path = sec.path;
    return (tree) => {
      if (!safePath(path)) throw new FailErr('unsafe', path);
      if (tree.get(path) === null) throw new FailErr('missing', path);
      tree.set(path, null);
    };
  }
  let raw = sec.raw;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    raw = raw.slice(1);
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  for (const rl of raw) {
    const l = rl.text;
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
      chunks.push(curChunk);
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk === null) throw new ParseErr(rl.num);
      curChunk.eof = true;
      curChunk = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (curChunk === null) {
        if (chunks.length > 0) throw new ParseErr(rl.num);
        curChunk = { anchor: null, eof: false, body: [] };
        chunks.push(curChunk);
      }
      curChunk.body.push({
        kind: l === '' ? ' ' : l[0]!,
        text: l === '' ? '' : l.slice(1),
      });
      continue;
    }
    throw new ParseErr(rl.num);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(sec.pathLine);
  const path = sec.path;
  return (tree) => {
    if (!safePath(path)) throw new FailErr('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new FailErr('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new FailErr('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new FailErr('exists', moveTo);
    const doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const hit = findTier(doc.lines, [ch.anchor], cursor, ctx.strict, false);
        if (hit === null) throw new FailErr('no-match', path);
        cursor = hit.positions[0]! + 1;
      }
      const oldLines: string[] = [];
      const newParts: NewPart[] = [];
      let oPos = 0;
      for (const b of ch.body) {
        if (b.kind === ' ') {
          oldLines.push(b.text);
          newParts.push({ text: b.text, ctx: oPos });
          oPos++;
        } else if (b.kind === '-') {
          oldLines.push(b.text);
          oPos++;
        } else if (b.kind === '+') {
          newParts.push({ text: b.text, ctx: null });
        }
      }
      if (oldLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const made = buildNew(doc.lines, at, oldLines, newParts, 0);
        doc.lines.splice(at, 0, ...made);
        cursor = at + made.length;
        continue;
      }
      const hit = findTier(doc.lines, oldLines, cursor, ctx.strict, ch.eof);
      if (hit === null) throw new FailErr('no-match', path);
      const at = hit.positions[0]!;
      const made = buildNew(doc.lines, at, oldLines, newParts, hit.tier);
      doc.lines.splice(at, oldLines.length, ...made);
      cursor = at + made.length;
    }
    if (moveTo !== null) {
      tree.set(moveTo, writeDoc(doc));
      tree.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.set(path, writeDoc(doc));
    }
  };
}

function parseV4a(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]!.trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let cur: VSectionRaw | null = null;
  const flush = (): void => {
    if (cur === null) return;
    while (cur.raw.length > 0 && cur.raw[cur.raw.length - 1]!.text.trim() === '') {
      cur.raw.pop();
    }
    edits.push(vSectionEdit(cur, ctx));
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    let kind: string | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(13).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(16).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(16).trim();
    }
    if (kind !== null) {
      flush();
      cur = { kind, path, pathLine: i + 1, raw: [] };
      continue;
    }
    if (cur === null) {
      if (line.trim() === '') continue;
      throw new ParseErr(i + 1);
    }
    cur.raw.push({ text: line, num: i + 1 });
  }
  flush();
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function existingText(tree: Tree, path: string): string {
  if (!safePath(path)) throw new FailErr('unsafe', path);
  const cur = tree.get(path);
  if (cur === null) throw new FailErr('missing', path);
  return cur;
}

function jsonEditObject(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;
  const path = obj.path;
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (tree) => {
      if (!safePath(path)) throw new FailErr('unsafe', path);
      if (tree.get(path) !== null) throw new FailErr('exists', path);
      tree.set(path, text);
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existingText(tree, path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count++;
      if (count === 0) throw new FailErr('no-match', path);
      if (count > 1) throw new FailErr('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const lineNo = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return (tree) => {
      const before = existingText(tree, path);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new FailErr('no-match', path);
      doc.lines.splice(lineNo, 0, ...added);
      tree.set(path, writeDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseErr(first + 1);
    for (const item of value) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new ParseErr(first + 1);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    let edit: Edit | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseErr(idx + 1);
    edits.push(edit);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running it (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const value = arg.slice('--format='.length);
        if (format !== null || !FORMATS.includes(value)) {
          return { code: 2, out: ['error: usage'] };
        }
        format = value;
      } else if (arg === '--check') {
        if (checkOnly) return { code: 2, out: ['error: usage'] };
        checkOnly = true;
      } else if (arg === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);
  const ctx: Ctx = { strict, moves: [] };
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(patchText, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else edits = parseV4a(lines, ctx);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const failures: FailErr[] = [];
  for (const edit of edits) {
    const saved = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof FailErr)) throw e;
      tree.now.clear();
      for (const [k, v] of saved) tree.now.set(k, v);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [from, to] of ctx.moves) {
    if (
      tree.orig(from) !== null &&
      tree.get(from) === null &&
      tree.orig(to) === null &&
      tree.get(to) !== null
    ) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.orig(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const byBytes = (a: string, b: string): number =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!checkOnly) {
    for (const p of [...tree.now.keys()].sort(byBytes)) {
      const was = tree.orig(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
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
