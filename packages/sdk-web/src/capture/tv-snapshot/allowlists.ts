// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Structural allowlists for the TV snapshot scrubber (spec §Privacy and
// masking). Everything here VALIDATES a value's shape so no allowlisted slot
// can smuggle free text: ARIA states are enumerated, SVG geometry is numeric,
// paint is a colour or a reference to a retained id. LAZY (tv-snapshot chunk).

/**
 * Own-property lookup. Keys here are page-controlled attribute/selector names,
 * so a plain `table[name]` would reach Object.prototype for `constructor`,
 * `__proto__`, `toString`… (Object.hasOwn is missing on old TV Chromium.)
 */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export const ARIA_STATE_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  'aria-current': new Set(['page', 'step', 'location', 'date', 'time', 'true', 'false']),
  'aria-pressed': new Set(['true', 'false', 'mixed']),
  'aria-selected': new Set(['true', 'false']),
  'aria-checked': new Set(['true', 'false', 'mixed']),
  'aria-expanded': new Set(['true', 'false']),
  'aria-disabled': new Set(['true', 'false']),
};

/** Is `value` one of the enumerated values of the ARIA state `name`? Own entries only. */
export function isAriaStateValue(name: string, value: string): boolean {
  const allowed = ownEntry(ARIA_STATE_VALUES, name);
  return allowed !== undefined && allowed.has(value);
}

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred ' +
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey ' +
    'snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen'
  ).split(' '),
);
const COLOR_KEYWORDS = new Set(['none', 'currentcolor', 'transparent', 'inherit', 'context-fill', 'context-stroke']);

const COLOR_FN_RE = /^(?:rgba?|hsla?)\(([^()]*)\)$/i;
/** One colour-function argument: a number with an optional %/angle unit, or `none`. */
const COLOR_ARG_RE = /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:%|deg|grad|rad|turn)?|none)$/i;

/** rgb()/hsl() with 3–4 numeric arguments only — the argument list can never spell words. */
function isColorFunction(t: string): boolean {
  const m = COLOR_FN_RE.exec(t);
  if (m === null) return false;
  const args = m[1]!.trim().split(/[\s,/]+/);
  return args.length >= 3 && args.length <= 4 && args.every((a) => COLOR_ARG_RE.test(a));
}

/** No real colour value is longer; the cap keeps every regex below on short input. */
const MAX_COLOR_LENGTH = 64;

export function isCssColor(v: string): boolean {
  if (v.length > MAX_COLOR_LENGTH) return false;
  const t = v.trim();
  const lower = t.toLowerCase();
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) ||
    isColorFunction(t) ||
    NAMED_COLORS.has(lower) ||
    COLOR_KEYWORDS.has(lower)
  );
}

const UNIT_NUMBER_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?:%|px|em|rem|pt)?$/;

/** Longer than any real coordinate; keeps each regex test on short input. */
const MAX_NUMBER_TOKEN_LENGTH = 64;

function isNumberList(v: string): boolean {
  const t = v.trim();
  if (t === '' || t.length > 20_000) return false;
  return t.split(/[\s,]+/).every((token) => token.length <= MAX_NUMBER_TOKEN_LENGTH && UNIT_NUMBER_RE.test(token));
}

const PATH_TOKEN_RE = /[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const COMMAND_RE = /^[A-Za-z]$/;

/** Real path data only: starts with a moveto, commands are followed by numbers (except closepath). */
export function isPathData(d: string): boolean {
  if (d.length > 100_000) return false;
  const tokens = d.match(PATH_TOKEN_RE);
  if (tokens === null || tokens.join('') !== d.replace(/[\s,]+/g, '')) return false;
  if (tokens[0] !== 'M' && tokens[0] !== 'm') return false;
  for (let k = 1; k < tokens.length; k++) {
    const prev = tokens[k - 1]!;
    if (COMMAND_RE.test(tokens[k]!) && COMMAND_RE.test(prev) && prev !== 'Z' && prev !== 'z') return false;
  }
  return true;
}

// One transform function per step of a linear scan. (A single anchored regex
// with a repeated group backtracks exponentially on a near-miss.)
const TRANSFORM_FN_RE = /\s*(?:matrix|translate|translateX|translateY|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*,?/y;
const TRANSFORM_ARGS_RE = /^[-+.\deE\s,]*$/;

function isTransformList(value: string): boolean {
  if (value.length > 2048 || value.trim() === '') return false;
  let pos = 0;
  while (value.slice(pos).trim() !== '') {
    TRANSFORM_FN_RE.lastIndex = pos;
    const m = TRANSFORM_FN_RE.exec(value);
    if (m === null || !TRANSFORM_ARGS_RE.test(m[1]!)) return false;
    pos = TRANSFORM_FN_RE.lastIndex;
  }
  return true;
}

const SVG_NUMERIC = new Set([
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'fr', 'offset',
  'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'flood-opacity',
  'stroke-width', 'stroke-miterlimit', 'stroke-dashoffset', 'stroke-dasharray',
  'viewBox', 'points', 'refX', 'refY', 'markerWidth', 'markerHeight', 'pathLength', 'width', 'height',
]);
const SVG_TRANSFORM = new Set(['transform', 'gradientTransform', 'patternTransform']);
const SVG_PAINT = new Set(['fill', 'stroke', 'stop-color', 'color', 'flood-color', 'lighting-color']);
const SVG_REF = new Set(['clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
const UNITS = /^(?:userSpaceOnUse|objectBoundingBox)$/;
const SVG_ENUM: Readonly<Record<string, RegExp>> = {
  'fill-rule': /^(?:nonzero|evenodd|inherit)$/,
  'clip-rule': /^(?:nonzero|evenodd|inherit)$/,
  'stroke-linecap': /^(?:butt|round|square|inherit)$/,
  'stroke-linejoin': /^(?:miter|miter-clip|round|bevel|arcs|inherit)$/,
  gradientUnits: UNITS,
  patternUnits: UNITS,
  patternContentUnits: UNITS,
  clipPathUnits: UNITS,
  maskUnits: UNITS,
  maskContentUnits: UNITS,
  filterUnits: UNITS,
  primitiveUnits: UNITS,
  markerUnits: /^(?:strokeWidth|userSpaceOnUse)$/,
  spreadMethod: /^(?:pad|reflect|repeat)$/,
  preserveAspectRatio: /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/,
  orient: /^(?:auto|auto-start-reverse|[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|rad|grad|turn)?)$/,
  visibility: /^(?:visible|hidden|collapse|inherit)$/,
  display: /^(?:none|inline|block|inherit)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
  'shape-rendering': /^(?:auto|optimizeSpeed|crispEdges|geometricPrecision)$/,
};

/** Every SVG_ENUM keyword/angle fits well within this. */
const MAX_ENUM_LENGTH = 64;

/** Longer than any real `url(#id) <fallback colour>` paint or reference. */
const MAX_REF_LENGTH = 1024;

const isSpace = (c: string): boolean => c !== '' && /\s/.test(c);
const isLineTerminator = (c: string): boolean => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

/**
 * `url( ['"]#id['"] ) rest` → the id and the rest (leading whitespace
 * skipped), or null — what /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i
 * matches, by a single forward scan. (That regex backtracks quadratically
 * between `\s*` and `(.*)` on a long whitespace run before a newline, S18.)
 */
function parseLocalRef(t: string): { id: string; rest: string } | null {
  if (t.slice(0, 4).toLowerCase() !== 'url(') return null;
  let i = 4;
  while (isSpace(t.charAt(i))) i++;
  if (t.charAt(i) === "'" || t.charAt(i) === '"') i++;
  if (t.charAt(i) !== '#') return null;
  const start = ++i;
  for (let c = t.charAt(i); c !== '' && c !== "'" && c !== '"' && c !== ')' && !isSpace(c); c = t.charAt(++i));
  if (i === start) return null;
  const id = t.slice(start, i);
  if (t.charAt(i) === "'" || t.charAt(i) === '"') i++;
  while (isSpace(t.charAt(i))) i++;
  if (t.charAt(i) !== ')') return null;
  i++;
  while (isSpace(t.charAt(i))) i++;
  for (let k = i; k < t.length; k++) if (isLineTerminator(t.charAt(k))) return null; // `.` stops at line ends
  return { id, rest: t.slice(i) };
}

function refToRetained(value: string, retainedIds: ReadonlySet<string>): { ok: boolean; rest: string } {
  if (value.length > MAX_REF_LENGTH) return { ok: false, rest: '' };
  const m = parseLocalRef(value.trim());
  if (m === null) return { ok: false, rest: '' };
  return { ok: retainedIds.has(m.id), rest: m.rest };
}

/** Is `name="value"` a validated SVG geometry/paint attribute? (Case-sensitive names, as the DOM keeps them.) */
export function isAllowedSvgAttr(name: string, value: string, retainedIds: ReadonlySet<string>): boolean {
  if (SVG_NUMERIC.has(name)) return isNumberList(value) || (name === 'stroke-dasharray' && value.trim() === 'none');
  if (name === 'd') return isPathData(value);
  if (SVG_TRANSFORM.has(name)) return isTransformList(value);
  if (SVG_PAINT.has(name)) {
    const ref = refToRetained(value, retainedIds);
    if (value.trim().toLowerCase().startsWith('url(')) return ref.ok && (ref.rest === '' || isCssColor(ref.rest));
    return isCssColor(value);
  }
  if (SVG_REF.has(name)) {
    if (value.trim() === 'none') return true;
    const ref = refToRetained(value, retainedIds);
    return ref.ok && ref.rest === '';
  }
  const pattern = ownEntry(SVG_ENUM, name);
  return pattern !== undefined && value.length <= MAX_ENUM_LENGTH && pattern.test(value.trim());
}
