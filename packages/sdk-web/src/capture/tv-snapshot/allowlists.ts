// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Structural allowlists for the TV snapshot scrubber (spec §Privacy and
// masking). Everything here VALIDATES a value's shape so no allowlisted slot
// can smuggle free text: ARIA states are enumerated, SVG geometry is numeric,
// paint is a colour or a reference to a retained id. LAZY (tv-snapshot chunk).

export const ARIA_STATE_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  'aria-current': new Set(['page', 'step', 'location', 'date', 'time', 'true', 'false']),
  'aria-pressed': new Set(['true', 'false', 'mixed']),
  'aria-selected': new Set(['true', 'false']),
  'aria-checked': new Set(['true', 'false', 'mixed']),
  'aria-expanded': new Set(['true', 'false']),
  'aria-disabled': new Set(['true', 'false']),
};

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
const COLOR_ARG_RE = /^(?:[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|deg|grad|rad|turn)?|none)$/i;

/** rgb()/hsl() with 3–4 numeric arguments only — the argument list can never spell words. */
function isColorFunction(t: string): boolean {
  const m = COLOR_FN_RE.exec(t);
  if (m === null) return false;
  const args = m[1]!.trim().split(/[\s,/]+/);
  return args.length >= 3 && args.length <= 4 && args.every((a) => COLOR_ARG_RE.test(a));
}

export function isCssColor(v: string): boolean {
  const t = v.trim();
  const lower = t.toLowerCase();
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) ||
    isColorFunction(t) ||
    NAMED_COLORS.has(lower) ||
    COLOR_KEYWORDS.has(lower)
  );
}

const UNIT_NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?:%|px|em|rem|pt)?$/;

function isNumberList(v: string): boolean {
  const t = v.trim();
  if (t === '' || t.length > 20_000) return false;
  return t.split(/[\s,]+/).every((token) => UNIT_NUMBER_RE.test(token));
}

const PATH_TOKEN_RE = /[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
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
  orient: /^(?:auto|auto-start-reverse|[-+]?\d*\.?\d+(?:deg|rad|grad|turn)?)$/,
  visibility: /^(?:visible|hidden|collapse|inherit)$/,
  display: /^(?:none|inline|block|inherit)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
  'shape-rendering': /^(?:auto|optimizeSpeed|crispEdges|geometricPrecision)$/,
};

const LOCAL_REF_RE = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i;

function refToRetained(value: string, retainedIds: ReadonlySet<string>): { ok: boolean; rest: string } {
  const m = LOCAL_REF_RE.exec(value.trim());
  if (m === null) return { ok: false, rest: '' };
  return { ok: retainedIds.has(m[1]!), rest: m[2] ?? '' };
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
  const pattern = SVG_ENUM[name];
  return pattern !== undefined && pattern.test(value.trim());
}
