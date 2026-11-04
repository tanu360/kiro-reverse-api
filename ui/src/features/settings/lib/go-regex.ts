/**
 * Whether Go's `regexp.Compile` accepts a pattern. The proxy compiles prompt-filter regexes with
 * it (RE2 syntax with Perl extensions) and skips a rule that fails, so the check follows Go's
 * parser (regexp/syntax/parse.go) rather than JavaScript's: inline flags such as `(?i)` or
 * `(?s-m:…)`, `(?P<name>…)`, `\Q…\E`, `\z` and `[[:alpha:]]` pass, while lookarounds,
 * backreferences, escapes Go does not know (`\Z`, `A`) and repeat counts over 1000 fail.
 */

const MAX_REPEAT = 1000;
const PERL_CLASSES = new Set(["d", "D", "s", "S", "w", "W"]);
const POSIX_CLASSES = new Set([
  "alnum",
  "alpha",
  "ascii",
  "blank",
  "cntrl",
  "digit",
  "graph",
  "lower",
  "print",
  "punct",
  "space",
  "upper",
  "word",
  "xdigit",
]);
const CONTROL_ESCAPES = new Map([
  ["a", 7],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
]);
// unicode.Categories and unicode.CategoryAliases; scripts are checked through JavaScript.
const CATEGORY_NAMES =
  "C Cc Cf Cn Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No " +
  "P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs " +
  "Cased_Letter Close_Punctuation Combining_Mark Connector_Punctuation Control Currency_Symbol " +
  "Dash_Punctuation Decimal_Number Enclosing_Mark Final_Punctuation Format Initial_Punctuation " +
  "Letter Letter_Number Line_Separator Lowercase_Letter Mark Math_Symbol Modifier_Letter " +
  "Modifier_Symbol Nonspacing_Mark Number Open_Punctuation Other Other_Letter Other_Number " +
  "Other_Punctuation Other_Symbol Paragraph_Separator Private_Use Punctuation Separator " +
  "Space_Separator Spacing_Mark Surrogate Symbol Titlecase_Letter Unassigned Uppercase_Letter " +
  "cntrl digit punct Any Assigned ASCII LC";
let categories: Set<string> | undefined;

const OCTAL = /^[0-7]$/;
const HEX = /^[0-9A-Fa-f]$/;
const ALNUM = /^[A-Za-z0-9]$/;
const CAPTURE_NAME = /^[A-Za-z0-9_]+$/;
const REPEAT = /^\{(0|[1-9][0-9]*)(?:(,)(0|[1-9][0-9]*)?)?\}/;

interface Char {
  cp: number;
  end: number;
}

/** Go's canonicalName: separators dropped, first letter upper case, the rest lower case. */
function canonicalName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (ch === "_" || ch === "-" || ch === " ") continue;
    // ASCII only, like Go, which works on bytes.
    if (out === "") out += ch >= "a" && ch <= "z" ? ch.toUpperCase() : ch;
    else out += ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
  }
  return out;
}

function isScript(name: string): boolean {
  // JavaScript wants the exact spelling (Old_Italic); Go also takes old italic or OLD-ITALIC.
  const words = name.split(/[_\- ]+/).filter(Boolean);
  const titled = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("_");
  return [name, titled].some((candidate) => {
    if (!CAPTURE_NAME.test(candidate)) return false;
    try {
      new RegExp(`\\p{Script=${candidate}}`, "u");
      return true;
    } catch {
      return false;
    }
  });
}

/** Go's unicodeTable: a category, a category alias or a script, matched loosely. */
function isUnicodeClassName(name: string): boolean {
  if (name === "") return false;
  categories ??= new Set(CATEGORY_NAMES.split(" ").map(canonicalName));
  return categories.has(canonicalName(name)) || isScript(name);
}

/** Go's parseEscape for the backslash at `at`: the character it stands for, or null. */
function parseEscape(p: string, at: number): Char | null {
  const c = p[at + 1];
  if (c === undefined) return null;
  const next = at + 2;
  // A lone \1 to \7 is a backreference, which RE2 lacks; followed by an octal digit it is octal.
  if (c === "0" || (c >= "1" && c <= "7" && OCTAL.test(p[next] ?? ""))) {
    let end = next;
    let cp = Number(c);
    while (end < next + 2 && OCTAL.test(p[end] ?? "")) {
      cp = cp * 8 + Number(p[end]);
      end++;
    }
    return { cp, end };
  }
  if (c === "x") {
    if (p[next] === "{") {
      const close = p.indexOf("}", next);
      const digits = close < 0 ? "" : p.slice(next + 1, close);
      if (!/^[0-9A-Fa-f]+$/.test(digits)) return null;
      const cp = Number.parseInt(digits, 16);
      return cp > 0x10ffff ? null : { cp, end: close + 1 };
    }
    if (!HEX.test(p[next] ?? "") || !HEX.test(p[next + 1] ?? "")) return null;
    return { cp: Number.parseInt(p.slice(next, next + 2), 16), end: next + 2 };
  }
  const control = CONTROL_ESCAPES.get(c);
  if (control !== undefined) return { cp: control, end: next };
  // Any other ASCII punctuation stands for itself; letters, digits and non-ASCII do not.
  const cp = c.charCodeAt(0);
  return cp < 0x80 && !ALNUM.test(c) ? { cp, end: next } : null;
}

/** Go's parseUnicodeClass for the `\p` or `\P` at `at`: where it ends, or null. */
function parseUnicodeClass(p: string, at: number): number | null {
  let end = at + 2;
  let name: string;
  if (p[end] === "{") {
    const close = p.indexOf("}", end);
    if (close < 0) return null;
    name = p.slice(end + 1, close);
    end = close + 1;
  } else {
    const cp = p.codePointAt(end);
    if (cp === undefined) return null;
    name = String.fromCodePoint(cp);
    end += name.length;
  }
  if (name.startsWith("^")) name = name.slice(1);
  return isUnicodeClassName(name) ? end : null;
}

function parseClassChar(p: string, at: number): Char | null {
  if (at >= p.length) return null;
  if (p[at] === "\\") return parseEscape(p, at);
  const cp = p.codePointAt(at) ?? 0;
  return { cp, end: at + (cp > 0xffff ? 2 : 1) };
}

/** Go's parseClass for the `[` at `at`: the index after its `]`, or null. */
function parseClass(p: string, at: number): number | null {
  let i = p[at + 1] === "^" ? at + 2 : at + 1;
  // A ] right after the opening bracket is a literal.
  let first = true;
  while (first || p[i] !== "]") {
    if (i >= p.length) return null;
    first = false;
    if (p.startsWith("[:", i) && p.length - i > 2) {
      const close = p.indexOf(":]", i + 2);
      if (close >= 0) {
        if (!POSIX_CLASSES.has(p.slice(i + 2, close).replace(/^\^/, ""))) return null;
        i = close + 2;
        continue;
      }
    }
    if (p[i] === "\\" && (p[i + 1] === "p" || p[i + 1] === "P")) {
      const end = parseUnicodeClass(p, i);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (p[i] === "\\" && PERL_CLASSES.has(p[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    const lo = parseClassChar(p, i);
    if (!lo) return null;
    i = lo.end;
    if (p[i] === "-" && i + 1 < p.length && p[i + 1] !== "]") {
      const hi = parseClassChar(p, i + 1);
      if (!hi || hi.cp < lo.cp) return null;
      i = hi.end;
    }
  }
  return i + 1;
}

/**
 * Go's parsePerlFlags for the `(?` at `at`: where parsing resumes and whether a group opens.
 * `(?i)` only sets flags; `(?i:`, `(?:`, `(?P<name>` and `(?<name>` open a group.
 */
function parsePerlGroup(p: string, at: number): { end: number; opens: boolean } | null {
  const named = p[at + 2] === "<" ? at + 3 : p[at + 2] === "P" && p[at + 3] === "<" ? at + 4 : -1;
  if (named > 0 && named < p.length) {
    const close = p.indexOf(">", at);
    if (close < 0 || !CAPTURE_NAME.test(p.slice(named, close))) return null;
    return { end: close + 1, opens: true };
  }
  let negated = false;
  let sawFlag = false;
  for (let i = at + 2; i < p.length; i++) {
    const c = p[i];
    if (c === "i" || c === "m" || c === "s" || c === "U") {
      sawFlag = true;
    } else if (c === "-" && !negated) {
      negated = true;
      sawFlag = false;
    } else if (c === ":" || c === ")") {
      if (negated && !sawFlag) return null;
      return { end: i + 1, opens: c === ":" };
    } else {
      return null;
    }
  }
  return null;
}

interface Frame {
  /** Heaviest finished item of the group, see `repeatWeight`. */
  done: number;
  /** The item a repetition operator would apply to; null at a group start or after `|`. */
  last: number | null;
}

/**
 * Go caps nested counted repeats (repeatIsValid): along any path the product of the `{n,m}`
 * counts may not pass 1000, so `(a{100}){11}` fails. A `{0}` drops its operand from the count.
 */
function repeatWeight(operand: number, min: number, max: number): number {
  if (max === 0) return 1;
  const count = max < 0 ? min : max;
  return count > 0 ? operand * count : operand;
}

export function compilesInGo(pattern: string): boolean {
  const p = pattern;
  const frames: Frame[] = [{ done: 1, last: null }];
  const top = () => frames[frames.length - 1];
  const item = (weight: number) => {
    const frame = top();
    frame.done = Math.max(frame.done, frame.last ?? 1);
    frame.last = weight;
  };
  // Go rejects stacked repetition operators (a** or a{2}*), not doubled ones.
  let lastWasRepeat = false;
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    let repeat = false;
    switch (c) {
      case "(": {
        if (p[i + 1] === "?") {
          const group = parsePerlGroup(p, i);
          if (!group) return false;
          if (group.opens) frames.push({ done: 1, last: null });
          i = group.end;
        } else {
          frames.push({ done: 1, last: null });
          i++;
        }
        break;
      }
      case ")": {
        const group = frames.pop();
        if (!group || frames.length === 0) return false;
        item(Math.max(group.done, group.last ?? 1));
        i++;
        break;
      }
      case "|": {
        const frame = top();
        frame.done = Math.max(frame.done, frame.last ?? 1);
        frame.last = null;
        i++;
        break;
      }
      case "[": {
        const end = parseClass(p, i);
        if (end === null) return false;
        item(1);
        i = end;
        break;
      }
      case "*":
      case "+":
      case "?":
      case "{": {
        let end = i + 1;
        let counted: { min: number; max: number } | null = null;
        if (c === "{") {
          const match = REPEAT.exec(p.slice(i));
          if (!match) {
            // Not a valid {n,m}: a literal brace.
            item(1);
            i++;
            break;
          }
          const min = Number(match[1]);
          const max = match[2] ? (match[3] === undefined ? -1 : Number(match[3])) : min;
          if (min > MAX_REPEAT || max > MAX_REPEAT || (max >= 0 && min > max)) return false;
          counted = { min, max };
          end = i + match[0].length;
        }
        if (p[end] === "?") end++;
        const frame = top();
        if (lastWasRepeat || frame.last === null) return false;
        if (counted) {
          frame.last = repeatWeight(frame.last, counted.min, counted.max);
          if (frame.last > MAX_REPEAT) return false;
        }
        repeat = true;
        i = end;
        break;
      }
      case "\\": {
        const next = p[i + 1];
        if (next === "C") return false;
        if (next === "Q") {
          // \Q…\E is literal text; an unclosed \Q runs to the end.
          const close = p.indexOf("\\E", i + 2);
          const end = close < 0 ? p.length : close;
          if (end > i + 2) item(1);
          i = close < 0 ? p.length : close + 2;
          break;
        }
        let end: number | null;
        if (next === "A" || next === "b" || next === "B" || next === "z") end = i + 2;
        else if (next === "p" || next === "P") end = parseUnicodeClass(p, i);
        else if (next !== undefined && PERL_CLASSES.has(next)) end = i + 2;
        else end = parseEscape(p, i)?.end ?? null;
        if (end === null) return false;
        item(1);
        i = end;
        break;
      }
      default: {
        item(1);
        i += (p.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      }
    }
    lastWasRepeat = repeat;
  }
  return frames.length === 1;
}
