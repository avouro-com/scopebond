// The one check every pattern a policy or a rule pack carries must pass before anything matches with it.
//
// Policy and pack patterns are tested against values an AI agent chooses (a path, a command's program, a host), so a pattern
// that can backtrack catastrophically would let the agent stall the check that is meant to stop it. A pattern is therefore
// read here, as JavaScript reads it (no flags), and refused when its shape can take more than quadratic time:
//
//   - a repeat that holds a repeat (`(a+)+`, `(?:x*y)*`), which backtracks exponentially;
//   - a repeat whose body can match nothing (`(a?)*`, `(?:a|){20}`);
//   - alternatives under a repeat that can begin with the same character (`(a|ab)*`, `(?:\d|[0-9a-f])+`), so one input
//     can be split between them in many ways;
//   - unbounded repeats next to each other whose characters overlap, with nothing between them that must be matched
//     (`.*.*`, `\w+\d*`, `.*x?.*`);
//   - three or more unbounded repeats in a row whose characters overlap, where whatever separates them the earlier repeat
//     could also match (`^.*a.*a.*a$`), which is polynomial of degree three or more. (The search a pattern without `^`
//     makes from every position counts as the first of them.) Two are allowed: their quadratic cost is bounded by the input
//     limit each caller applies (a policy value longer than `POLICY_PATTERN_INPUT_MAX` fails its pattern; a pack clips);
//   - back-references and look-behind, which the matcher cannot run in bounded time.
//
// The check is conservative: a pattern it cannot read is refused, never assumed safe. A refused pattern is an invalid policy
// or an invalid pack, exactly as one that does not parse.

/** The longest pattern a signed rule pack may carry. */
export const PACK_PATTERN_MAX = 200;
/** The longest pattern a policy may carry (a starter protection's patterns are long lists of alternatives). */
export const POLICY_PATTERN_MAX = 16_384;
/** The longest value a policy pattern is tested on. A longer value fails the pattern (an allowlist bound is not met, an
 *  exception does not apply): clipping it instead could let a value whose excess the pattern would refuse pass. */
export const POLICY_PATTERN_INPUT_MAX = 4_096;

// ---- character sets: UTF-16 code units, the ASCII ones as four 32-bit masks, the rest as sorted disjoint ranges ---------
// (A pattern is read on every policy load, so the sets are kept cheap: nearly every character a pattern names is ASCII.)

interface CharSet {
  readonly m0: number; readonly m1: number; readonly m2: number; readonly m3: number;
  /** Inclusive ranges of code units from 0x80 up, sorted and disjoint. */
  readonly hi: ReadonlyArray<readonly [number, number]>;
}
const MAX_UNIT = 0xffff;
const NO_RANGES: ReadonlyArray<readonly [number, number]> = [];
const NONE: CharSet = { m0: 0, m1: 0, m2: 0, m3: 0, hi: NO_RANGES };
const FULL = 0xffffffff;
const ANY: CharSet = { m0: FULL, m1: FULL, m2: FULL, m3: FULL, hi: [[0x80, MAX_UNIT]] };

function mergeRanges(ranges: Array<readonly [number, number]>): ReadonlyArray<readonly [number, number]> {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of ranges) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** The set of `lo`..`hi` inclusive. */
function rangeSet(lo: number, hi: number): CharSet {
  const m = [0, 0, 0, 0];
  for (let c = lo; c <= Math.min(hi, 0x7f); c++) m[c >> 5] |= 1 << (c & 31);
  return { m0: m[0] >>> 0, m1: m[1] >>> 0, m2: m[2] >>> 0, m3: m[3] >>> 0, hi: hi >= 0x80 ? [[Math.max(lo, 0x80), hi]] : NO_RANGES };
}
const units = new Map<number, CharSet>();
/** The set of one character (shared: sets are never changed). */
function unit(c: number): CharSet {
  let s = units.get(c);
  if (!s) { s = rangeSet(c, c); units.set(c, s); }
  return s;
}

function union(...sets: CharSet[]): CharSet {
  if (sets.length === 1) return sets[0];
  let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
  let hi: Array<readonly [number, number]> | null = null;
  let oneHi: ReadonlyArray<readonly [number, number]> = NO_RANGES;
  for (const s of sets) {
    m0 |= s.m0; m1 |= s.m1; m2 |= s.m2; m3 |= s.m3;
    if (s.hi.length) {
      if (oneHi.length === 0 && hi === null) oneHi = s.hi;
      else { hi ??= [...oneHi]; hi.push(...s.hi); }
    }
  }
  return { m0: m0 >>> 0, m1: m1 >>> 0, m2: m2 >>> 0, m3: m3 >>> 0, hi: hi ? mergeRanges(hi) : oneHi };
}

function complement(s: CharSet): CharSet {
  const hi: Array<[number, number]> = [];
  let next = 0x80;
  for (const [lo, h] of s.hi) { if (lo > next) hi.push([next, lo - 1]); next = h + 1; }
  if (next <= MAX_UNIT) hi.push([next, MAX_UNIT]);
  return { m0: ~s.m0 >>> 0, m1: ~s.m1 >>> 0, m2: ~s.m2 >>> 0, m3: ~s.m3 >>> 0, hi };
}

function overlaps(a: CharSet, b: CharSet): boolean {
  if ((a.m0 & b.m0) | (a.m1 & b.m1) | (a.m2 & b.m2) | (a.m3 & b.m3)) return true;
  let i = 0, j = 0;
  while (i < a.hi.length && j < b.hi.length) {
    if (a.hi[i][1] < b.hi[j][0]) i++;
    else if (b.hi[j][1] < a.hi[i][0]) j++;
    else return true;
  }
  return false;
}

/** Whether every character of `a` is in `b`. */
function within(a: CharSet, b: CharSet): boolean {
  if ((a.m0 & ~b.m0) | (a.m1 & ~b.m1) | (a.m2 & ~b.m2) | (a.m3 & ~b.m3)) return false;
  let j = 0;
  for (const [lo, hi] of a.hi) {
    while (j < b.hi.length && b.hi[j][1] < lo) j++;
    if (j === b.hi.length || b.hi[j][0] > lo || b.hi[j][1] < hi) return false;
  }
  return true;
}

/** The one character a set holds, or null when it holds none or more than one. */
function singleCode(s: CharSet): number | null {
  const masks = [s.m0, s.m1, s.m2, s.m3];
  let found: number | null = null;
  for (let w = 0; w < 4; w++) {
    const m = masks[w];
    if (!m) continue;
    if (found !== null || (m & (m - 1)) !== 0) return null;
    found = w * 32 + (31 - Math.clz32(m));
  }
  if (s.hi.length === 0) return found;
  return found === null && s.hi.length === 1 && s.hi[0][0] === s.hi[0][1] ? s.hi[0][0] : null;
}

const DIGIT: CharSet = rangeSet(0x30, 0x39);
const WORD: CharSet = union(DIGIT, rangeSet(0x41, 0x5a), unit(0x5f), rangeSet(0x61, 0x7a));
const SPACE: CharSet = union(rangeSet(0x09, 0x0d), unit(0x20), unit(0xa0), unit(0x1680), rangeSet(0x2000, 0x200a), rangeSet(0x2028, 0x2029),
  unit(0x202f), unit(0x205f), unit(0x3000), unit(0xfeff));
const DOT: CharSet = complement(union(unit(0x0a), unit(0x0d), rangeSet(0x2028, 0x2029)));

// ---- the pattern, read into a tree --------------------------------------------------------------------------------------

type Node = (
  | { t: "char"; set: CharSet }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; alts: Node[] }
  | { t: "group"; body: Node }
  | { t: "look"; body: Node }
  | { t: "assert"; start: boolean }
  | { t: "rep"; body: Node; min: number; max: number }
) & { shape?: Shape };

class Refusal extends Error {}

class Reader {
  i = 0;
  constructor(readonly s: string) {}

  read(): Node {
    const node = this.alternation();
    if (this.i !== this.s.length) throw new Refusal("could not be read");
    return node;
  }

  private alternation(): Node {
    const alts = [this.sequence()];
    while (this.s[this.i] === "|") { this.i++; alts.push(this.sequence()); }
    return alts.length === 1 ? alts[0] : { t: "alt", alts };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "|" && this.s[this.i] !== ")") items.push(this.quantified(this.atom()));
    return { t: "seq", items };
  }

  private quantified(atom: Node): Node {
    const c = this.s[this.i];
    let min: number, max: number;
    if (c === "*") { min = 0; max = Infinity; this.i++; }
    else if (c === "+") { min = 1; max = Infinity; this.i++; }
    else if (c === "?") { min = 0; max = 1; this.i++; }
    else if (c === "{") {
      // eslint-disable-next-line security/detect-unsafe-regex -- linear (digits, then an optional comma and digits) and run on at most 24 characters
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i, this.i + 24));
      if (!m) return atom;
      min = Number(m[1]); max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      this.i += m[0].length;
    } else return atom;
    if (this.s[this.i] === "?") this.i++; // lazy: the same matches, tried in another order
    return { t: "rep", body: atom, min, max };
  }

  private atom(): Node {
    const c = this.s[this.i++];
    if (c === "^") return { t: "assert", start: true };
    if (c === "$") return { t: "assert", start: false };
    if (c === ".") return { t: "char", set: DOT };
    if (c === "[") return { t: "char", set: this.charClass() };
    if (c === "\\") return this.escape();
    if (c === "(") {
      let look = false;
      if (this.s.startsWith("?<=", this.i) || this.s.startsWith("?<!", this.i)) throw new Refusal("look-behind is not allowed");
      if (this.s.startsWith("?=", this.i) || this.s.startsWith("?!", this.i)) { look = true; this.i += 2; }
      else if (this.s.startsWith("?:", this.i)) this.i += 2;
      else if (this.s.startsWith("?<", this.i)) { const end = this.s.indexOf(">", this.i); if (end < 0) throw new Refusal("could not be read"); this.i = end + 1; }
      else if (this.s[this.i] === "?") throw new Refusal("could not be read");
      const body = this.alternation();
      if (this.s[this.i] !== ")") throw new Refusal("could not be read");
      this.i++;
      return look ? { t: "look", body } : { t: "group", body };
    }
    // Anything else is itself (outside a class, `]`, `{` and `}` that start no quantifier are literal).
    return { t: "char", set: unit(c.charCodeAt(0)) };
  }

  /** An escape outside a class. */
  private escape(): Node {
    const c = this.s[this.i++];
    if (c === undefined) throw new Refusal("could not be read");
    if (c === "b" || c === "B") return { t: "assert", start: false };
    if (/[1-9]/.test(c)) throw new Refusal("back-references are not allowed");
    if (c === "k" && this.s[this.i] === "<") throw new Refusal("back-references are not allowed");
    return { t: "char", set: this.escapedSet(c, false) };
  }

  /** What an escaped character stands for (after the backslash, `c` already read). */
  private escapedSet(c: string, inClass: boolean): CharSet {
    switch (c) {
      case "d": return DIGIT;
      case "D": return complement(DIGIT);
      case "w": return WORD;
      case "W": return complement(WORD);
      case "s": return SPACE;
      case "S": return complement(SPACE);
      case "n": return unit(0x0a);
      case "r": return unit(0x0d);
      case "t": return unit(0x09);
      case "v": return unit(0x0b);
      case "f": return unit(0x0c);
      case "b": return inClass ? unit(0x08) : unit(0x62);
      case "x": case "u": {
        const len = c === "x" ? 2 : 4;
        const hex = this.s.slice(this.i, this.i + len);
        if (hex.length === len && /^[0-9A-Fa-f]+$/.test(hex)) { this.i += len; return unit(parseInt(hex, 16)); }
        return unit(c.charCodeAt(0));
      }
      case "c": {
        const letter = this.s[this.i];
        if (letter && /[A-Za-z]/.test(letter)) { this.i++; return unit(letter.charCodeAt(0) % 32); }
        return ANY; // an unusual spelling: read as any character, which only ever refuses more
      }
      default:
        if (/[0-7]/.test(c)) { // `\0` and, in a class, an octal escape
          let digits = c;
          while (digits.length < 3 && /[0-7]/.test(this.s[this.i] ?? "")) digits += this.s[this.i++];
          return unit(parseInt(digits, 8) & 0xff);
        }
        return unit(c.charCodeAt(0));
    }
  }

  private charClass(): CharSet {
    let negate = false;
    if (this.s[this.i] === "^") { negate = true; this.i++; }
    const parts: CharSet[] = [];
    while (this.i < this.s.length && this.s[this.i] !== "]") {
      const from = this.classAtom();
      if (this.s[this.i] === "-" && this.s[this.i + 1] !== "]" && this.i + 1 < this.s.length) {
        this.i++;
        const to = this.classAtom();
        const lo = singleCode(from), hi = singleCode(to);
        if (lo !== null && hi !== null && lo <= hi) parts.push(rangeSet(lo, hi));
        else parts.push(from, to, unit(0x2d)); // `[\d-x]`: the class escape, the hyphen and the other end, each itself
      } else parts.push(from);
    }
    if (this.s[this.i] !== "]") throw new Refusal("could not be read");
    this.i++;
    const set = union(...parts);
    return negate ? complement(set) : set;
  }

  private classAtom(): CharSet {
    const c = this.s[this.i++];
    if (c === "\\") {
      const e = this.s[this.i++];
      if (e === undefined) throw new Refusal("could not be read");
      return this.escapedSet(e, true);
    }
    return unit(c.charCodeAt(0));
  }
}

// ---- the checks ---------------------------------------------------------------------------------------------------------

const NESTED = "a repeated group that holds a repeat is not allowed (it can backtrack)";
const EMPTY_BODY = "a repeated group that can match nothing is not allowed (it can backtrack)";
const AMBIGUOUS = "alternatives under a repeat that can begin with the same character are not allowed (they can backtrack)";
const ADJACENT = "unbounded repeats next to each other that can match the same characters are not allowed (they can backtrack)";
const CHOICES = "more than 8 places that can match the same input two ways are not allowed (backtracking tries every combination)";
/** Places one input can match two ways, outside a repeat: each can double the work on a value that does not match. */
const MAX_CHOICES = 8;
const POLYNOMIAL = "three or more unbounded repeats in a row that can match the same characters are not allowed (they can backtrack)";

/** What a node matches, as the checks need it. */
interface Shape {
  /** It can match the empty string. */
  nullable: boolean;
  /** Every character it can consume. */
  chars: CharSet;
  /** The characters it can begin with. */
  first: CharSet;
  /** The characters it can end with. */
  last: CharSet;
  /** It can consume an unbounded number of characters. */
  unbounded: boolean;
  /** The characters of an unbounded repeat it can begin with (null: it begins with none). */
  lead: CharSet | null;
  /** The characters of an unbounded repeat it can end with (null: it ends with none). */
  trail: CharSet | null;
  /** How many overlapping unbounded repeats it chains, at most (the polynomial degree it contributes). */
  degree: number;
  /** How many places in it (outside look-arounds) one input can be matched two ways: an optional part followed by something
   *  that can begin the same way, alternatives that can begin the same way. Backtracking can try every combination. */
  choices: number;
}

/** A repeat above this many is as costly as an unbounded one. */
const LARGE_REPEAT = 100;

const either = (a: CharSet | null, b: CharSet | null): CharSet | null => (a === null ? b : b === null ? a : union(a, b));

const isEmpty = (s: CharSet): boolean => !(s.m0 | s.m1 | s.m2 | s.m3) && s.hi.length === 0;

/** Whether two alternatives can begin the same way (or one can match nothing). */
function alike(all: Shape[]): boolean {
  if (all.some((s) => s.nullable)) return true;
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) if (overlaps(all[a].first, all[b].first)) return true;
  return false;
}

function holdsRepeat(node: Node): boolean {
  switch (node.t) {
    case "rep": return node.max > 1 || holdsRepeat(node.body);
    case "seq": return node.items.some(holdsRepeat);
    case "alt": return node.alts.some(holdsRepeat);
    case "group": case "look": return holdsRepeat(node.body);
    default: return false;
  }
}

/** The characters every repeat inside `node` can consume; null when a look-around inside holds a repeat (it is tried at every
 *  turn, whatever the turn begins with). */
function innerRepeatChars(node: Node): CharSet | null {
  switch (node.t) {
    case "rep": {
      if (node.max > 1) return shape(node.body).chars;
      return innerRepeatChars(node.body);
    }
    case "seq": case "alt": {
      let all: CharSet = NONE;
      for (const n of node.t === "seq" ? node.items : node.alts) {
        const c = innerRepeatChars(n);
        if (c === null) return null;
        all = union(all, c);
      }
      return all;
    }
    case "group": return innerRepeatChars(node.body);
    case "look": return holdsRepeat(node.body) ? null : NONE;
    default: return NONE;
  }
}

/** Whether every repeat inside a repeated body is closed by a separator it cannot consume: directly followed, in its own
 *  sequence, by a required part that cannot begin with any of its characters (`(?:[a-z0-9-]+.)*`, `(?:[^/]+/)*`). Each inner
 *  repeat then stops at its separator and each turn ends there, so nothing is split two ways. */
function terminated(node: Node): boolean {
  const repeatOf = (n: Node): (Node & { t: "rep" }) | null => {
    if (n.t === "rep") return n.max > 1 ? n : null;
    if (n.t === "group" && n.body.t === "seq" && n.body.items.length === 1) return repeatOf(n.body.items[0]);
    return null;
  };
  switch (node.t) {
    case "char": case "assert": return true;
    case "look": return !holdsRepeat(node.body);
    case "group": return terminated(node.body);
    case "alt": return node.alts.every(terminated);
    case "rep": return node.max <= 1 && terminated(node.body);
    case "seq":
      return node.items.every((item, i) => {
        const r = repeatOf(item);
        if (r === null) return terminated(item);
        if (holdsRepeat(r.body)) return false;
        const next = node.items[i + 1];
        if (next === undefined) return false;
        const after = shape(next);
        return !after.nullable && !after.unbounded && !overlaps(after.first, shape(r.body).chars);
      });
  }
}

/** Every alternation in a repeated body (outside look-arounds, which never backtrack into) must start unambiguously. */
function checkAlternatives(node: Node): void {
  switch (node.t) {
    case "alt": {
      const shapes = node.alts.map((n) => shape(n));
      if (shapes.some((s) => s.nullable)) throw new Refusal(AMBIGUOUS);
      for (let a = 0; a < shapes.length; a++) for (let b = a + 1; b < shapes.length; b++) if (overlaps(shapes[a].first, shapes[b].first)) throw new Refusal(AMBIGUOUS);
      node.alts.forEach(checkAlternatives);
      return;
    }
    case "seq": node.items.forEach(checkAlternatives); return;
    case "group": case "rep": checkAlternatives(node.body); return;
    default: return;
  }
}

/** Each node's shape, once (a node is read again by the checks of every repeat around it). */
function shape(node: Node, searched = false): Shape {
  if (searched) return computeShape(node, true);
  return (node.shape ??= computeShape(node, false));
}

function computeShape(node: Node, searched: boolean): Shape {
  switch (node.t) {
    case "char": return { nullable: false, chars: node.set, first: node.set, last: node.set, unbounded: false, lead: null, trail: null, degree: 0, choices: 0 };
    case "assert": return { nullable: true, chars: NONE, first: NONE, last: NONE, unbounded: false, lead: null, trail: null, degree: 0, choices: 0 };
    case "look": {
      // Zero-width, and never backtracked into; what it costs at each position it is tried counts where it stands in a
      // sequence (`degree`).
      const inner = shape(node.body);
      // A look-around is matched once and never backtracked into: its own choices count on their own.
      if (inner.choices > MAX_CHOICES) throw new Refusal(CHOICES);
      return { nullable: true, chars: NONE, first: NONE, last: NONE, unbounded: false, lead: null, trail: null, degree: inner.degree, choices: 0 };
    }
    case "group": return shape(node.body);
    case "alt": {
      const all = node.alts.map((n) => shape(n, searched));
      return {
        nullable: all.some((s) => s.nullable), chars: union(...all.map((s) => s.chars)), first: union(...all.map((s) => s.first)), last: union(...all.map((s) => s.last)),
        unbounded: all.some((s) => s.unbounded), lead: all.reduce<CharSet | null>((a, s) => either(a, s.lead), null),
        trail: all.reduce<CharSet | null>((a, s) => either(a, s.trail), null), degree: Math.max(...all.map((s) => s.degree)),
        choices: all.reduce((n, s) => n + s.choices, 0) + (alike(all) ? 1 : 0),
      };
    }
    case "rep": {
      const body = shape(node.body);
      if (node.max > 1) {
        // A repeat may hold a repeat only when every turn begins with a character no inner repeat can consume
        // (`(?:/[^/]+)*`): each turn then ends where the next begins, and nothing is split two ways.
        if (holdsRepeat(node.body)) {
          const inner = innerRepeatChars(node.body);
          if (inner === null || (overlaps(inner, body.first) && !terminated(node.body))) throw new Refusal(NESTED);
        }
        if (body.nullable) throw new Refusal(EMPTY_BODY);
        checkAlternatives(node.body);
      }
      // A repeat of more than one holds no repeat (checked above), so it is one unbounded member at most; `?` keeps what its
      // body is.
      const large = node.max > LARGE_REPEAT;
      return {
        nullable: node.min === 0 || body.nullable, chars: body.chars, first: body.first, last: body.last, unbounded: large || body.unbounded,
        // At the edges an unbounded repeat is what a turn begins and ends with: `(?:[^.]+.)*[a-z]+` splits one way only.
        lead: large ? body.first : body.lead, trail: large ? body.last : body.trail, degree: large ? 1 : body.degree,
        // A choice inside a repeated body is made again at every turn.
        choices: node.max > 1 ? body.choices * Math.min(node.max, MAX_CHOICES + 1) : body.choices,
      };
    }
    case "seq": return sequenceShape(node.items, searched);
  }
}

/** A sequence, read left to right.
 *  - Adjacent: an unbounded repeat it can begin with, after one the sequence so far can end with, sharing characters.
 *  - Polynomial: the run of overlapping unbounded members, kept alive while what separates them could be consumed by the
 *    last of them. `searched`: the pattern is tried from every position (no `^`), which starts that run. */
function sequenceShape(items: Node[], searched: boolean): Shape {
  const anchored = items[0]?.t === "assert" && items[0].start;
  const implicitRun = searched && !anchored;
  let run = implicitRun ? 1 : 0;
  let last: CharSet | null = implicitRun ? ANY : null;
  let pendingTrail: CharSet | null = null; // what an unbounded repeat just before this point can consume
  let maxDegree = 0;
  let nullable = true, unbounded = false;
  // Gathered, then merged once: merging at every item made a long run of look-aheads quadratic.
  const chars: CharSet[] = [], first: CharSet[] = [], lead: CharSet[] = [];
  let trail: CharSet | null = null;
  let choices = 0;
  let optionalFirst: CharSet | null = null; // what the optional parts since the last required one can begin with
  for (const item of items) {
    const s = shape(item);
    if (nullable) { first.push(s.first); if (s.lead) lead.push(s.lead); }
    chars.push(s.chars);
    choices += s.choices;
    if (item.t !== "assert" && item.t !== "look") {
      if (optionalFirst !== null && overlaps(optionalFirst, s.first)) choices++;
      optionalFirst = s.nullable ? (isEmpty(s.first) ? optionalFirst : either(optionalFirst, s.first)) : null;
    }
    if (item.t === "assert") continue;
    if (s.lead !== null && pendingTrail !== null && overlaps(pendingTrail, s.lead)) throw new Refusal(ADJACENT);
    pendingTrail = s.nullable ? either(pendingTrail, s.trail) : s.trail;
    trail = s.nullable ? either(trail, s.trail) : s.trail;
    if (item.t === "look") {
      if (s.degree > 0 && last !== null && run + s.degree > 2) throw new Refusal(POLYNOMIAL);
      maxDegree = Math.max(maxDegree, s.degree);
      continue;
    }
    if (s.unbounded) {
      unbounded = true;
      if (last !== null && overlaps(last, s.chars)) {
        run += s.degree;
        if (run > 2) throw new Refusal(POLYNOMIAL);
      } else run = s.degree;
      last = s.chars;
    } else if (last !== null && (s.nullable || within(s.chars, last))) {
      // A separator the last unbounded member could also match: the run goes on.
    } else {
      run = 0; last = null;
    }
    maxDegree = Math.max(maxDegree, run);
    if (!s.nullable) nullable = false;
  }
  const lastSets: CharSet[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const s = shape(items[i]);
    lastSets.push(s.last);
    if (!s.nullable) break;
  }
  return { nullable, chars: union(...chars), first: union(...first), last: union(...lastSets), unbounded, lead: lead.length ? union(...lead) : null, trail, degree: maxDegree, choices };
}

/** Why `pattern` is refused, or null when it is accepted. `maxLength` is the caller's cap (`PACK_PATTERN_MAX`,
 *  `POLICY_PATTERN_MAX`). A pattern is compiled with no flags, as policies and packs use them. */
export function patternProblem(pattern: unknown, maxLength: number = POLICY_PATTERN_MAX): string | null {
  if (typeof pattern !== "string") return "must be a string";
  if (pattern.length > maxLength) return `is longer than ${maxLength} characters`;
  const known = verdicts.get(pattern);
  if (known !== undefined) return known;
  const problem = readPattern(pattern);
  if (verdicts.size >= 500) verdicts.clear();
  verdicts.set(pattern, problem);
  return problem;
}

/** Each pattern's verdict, once per process: a policy is validated on every load, with the same patterns. */
const verdicts = new Map<string, string | null>();

function readPattern(pattern: string): string | null {
  // eslint-disable-next-line security/detect-non-literal-regexp -- compiled only to check that it parses; never matched here
  try { new RegExp(pattern); } catch { return "is not a valid regular expression"; }
  try {
    const tree = new Reader(pattern).read();
    // The top level is searched from every position unless an alternative starts with `^`.
    const top = tree.t === "alt" ? tree.alts.map((alt) => shape(alt, true)) : [shape(tree, true)];
    if (top.reduce((n, s) => n + s.choices, 0) + (tree.t === "alt" && alike(top) ? 1 : 0) > MAX_CHOICES) throw new Refusal(CHOICES);
    return null;
  } catch (error) {
    if (error instanceof Refusal) return error.message === "could not be read" ? "could not be checked as a bounded regular expression" : error.message;
    return "could not be checked as a bounded regular expression";
  }
}

