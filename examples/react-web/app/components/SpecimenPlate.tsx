// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SpecimenPlate — generative SVG "pinned specimen" illustration. Each insect
// is drawn from its catalog data (kind + colours + spots/glow/mandibles), so
// the example needs no binary image assets and every plate is still visually
// distinct. Deterministic output only — no randomness, no timestamps — to
// keep Next.js SSR hydration byte-stable (asserted by ssr-fixture.spec.ts).
import type { Specimen } from "../lib/specimens";

/** Positions (cx, cy) for up to 7 elytra spots, mirrored around the midline. */
const SPOT_SLOTS: Array<[number, number]> = [
  [88, 108],
  [112, 108],
  [80, 128],
  [120, 128],
  [92, 148],
  [108, 148],
  [100, 92],
];

function BeetleBody({ plate }: { plate: Specimen["plate"] }) {
  const { color, color2 = "#20241c", spots = 0, glow, mandibles } = plate;
  return (
    <g>
      {/* legs — three arcs per side */}
      <g stroke={color2} strokeWidth="2.5" fill="none" strokeLinecap="round">
        <path d="M84 96 C 66 88, 58 78, 52 64" />
        <path d="M116 96 C 134 88, 142 78, 148 64" />
        <path d="M80 118 C 60 118, 50 112, 40 104" />
        <path d="M120 118 C 140 118, 150 112, 160 104" />
        <path d="M84 140 C 68 150, 60 158, 54 168" />
        <path d="M116 140 C 132 150, 140 158, 146 168" />
      </g>
      {/* antennae */}
      <g stroke={color2} strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M92 66 C 84 52, 76 46, 64 42" />
        <path d="M108 66 C 116 52, 124 46, 136 42" />
      </g>
      {mandibles ? (
        // Stag "antlers" — forked mandibles reaching up from the head.
        <g stroke={color} strokeWidth="5" fill="none" strokeLinecap="round">
          <path d="M92 62 C 86 46, 84 36, 88 24 M88 24 L 80 30 M88 24 L 94 32" />
          <path d="M108 62 C 114 46, 116 36, 112 24 M112 24 L 120 30 M112 24 L 106 32" />
        </g>
      ) : null}
      {/* head + pronotum + elytra */}
      <circle cx="100" cy="68" r="11" fill={color2} />
      <ellipse cx="100" cy="86" rx="17" ry="12" fill={color2} />
      <path
        d="M100 92 C 124 92, 134 112, 134 130 C 134 152, 120 168, 100 168 C 80 168, 66 152, 66 130 C 66 112, 76 92, 100 92 Z"
        fill={color}
      />
      {/* elytra seam */}
      <line x1="100" y1="94" x2="100" y2="166" stroke={color2} strokeWidth="1.5" opacity="0.65" />
      {SPOT_SLOTS.slice(0, spots).map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="5.5" fill={color2} />
      ))}
      {glow ? (
        <>
          <circle className="plate-glow" cx="100" cy="158" r="18" fill="url(#everframe-glow)" />
          <ellipse cx="100" cy="158" rx="10" ry="7" fill="#e8f2a0" />
        </>
      ) : null}
    </g>
  );
}

function ButterflyBody({ plate }: { plate: Specimen["plate"] }) {
  const { color, color2 = "#3e5f8a" } = plate;
  return (
    <g>
      {/* forewings */}
      <path d="M96 100 C 70 62, 44 54, 32 66 C 22 78, 34 104, 96 112 Z" fill={color} />
      <path d="M104 100 C 130 62, 156 54, 168 66 C 178 78, 166 104, 104 112 Z" fill={color} />
      {/* hindwings */}
      <path d="M96 112 C 64 116, 48 134, 54 152 C 60 166, 84 158, 98 124 Z" fill={color} opacity="0.85" />
      <path d="M104 112 C 136 116, 152 134, 146 152 C 140 166, 116 158, 102 124 Z" fill={color} opacity="0.85" />
      {/* eyespots */}
      <g>
        <circle cx="56" cy="76" r="9" fill={color2} />
        <circle cx="56" cy="76" r="3.5" fill="#e9e4c9" />
        <circle cx="144" cy="76" r="9" fill={color2} />
        <circle cx="144" cy="76" r="3.5" fill="#e9e4c9" />
        <circle cx="70" cy="140" r="6" fill={color2} />
        <circle cx="130" cy="140" r="6" fill={color2} />
      </g>
      {/* body + antennae */}
      <ellipse cx="100" cy="112" rx="6" ry="26" fill="#20241c" />
      <circle cx="100" cy="84" r="7" fill="#20241c" />
      <g stroke="#20241c" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M96 79 C 88 66, 82 60, 74 56" />
        <path d="M104 79 C 112 66, 118 60, 126 56" />
      </g>
    </g>
  );
}

function DamselflyBody({ plate }: { plate: Specimen["plate"] }) {
  const { color, color2 = "#20241c" } = plate;
  return (
    <g>
      {/* wings folded back along the abdomen */}
      <g fill={color} opacity="0.18" stroke={color} strokeWidth="1">
        <ellipse cx="112" cy="96" rx="34" ry="9" transform="rotate(38 112 96)" />
        <ellipse cx="88" cy="96" rx="34" ry="9" transform="rotate(142 88 96)" />
        <ellipse cx="116" cy="104" rx="30" ry="8" transform="rotate(44 116 104)" />
        <ellipse cx="84" cy="104" rx="30" ry="8" transform="rotate(136 84 104)" />
      </g>
      {/* abdomen — long, segmented */}
      <rect x="97" y="92" width="6" height="76" rx="3" fill={color} />
      {[104, 118, 132, 146, 158].map((y) => (
        <rect key={y} x="97" y={y} width="6" height="3" fill={color2} opacity="0.7" />
      ))}
      {/* thorax + wide-set eyes */}
      <ellipse cx="100" cy="84" rx="10" ry="12" fill={color} />
      <circle cx="91" cy="66" r="7" fill={color2} />
      <circle cx="109" cy="66" r="7" fill={color2} />
      {/* legs */}
      <g stroke={color2} strokeWidth="1.8" fill="none" strokeLinecap="round">
        <path d="M93 90 C 82 96, 76 102, 72 110" />
        <path d="M107 90 C 118 96, 124 102, 128 110" />
      </g>
    </g>
  );
}

function MantisBody({ plate }: { plate: Specimen["plate"] }) {
  const { color, color2 = "#8aa35e" } = plate;
  return (
    <g>
      {/* abdomen + folded wings */}
      <ellipse cx="104" cy="134" rx="14" ry="34" fill={color} transform="rotate(14 104 134)" />
      <path d="M100 104 C 118 116, 122 146, 112 164" stroke={color2} strokeWidth="2" fill="none" />
      {/* thorax — long pronotum */}
      <rect x="92" y="74" width="9" height="38" rx="4.5" fill={color} transform="rotate(-8 96 93)" />
      {/* triangular head, tilted */}
      <path d="M88 58 L 108 62 L 96 76 Z" fill={color2} />
      <circle cx="91" cy="62" r="2.6" fill="#20241c" />
      <circle cx="104" cy="64" r="2.6" fill="#20241c" />
      <g stroke="#20241c" strokeWidth="1.5" fill="none" strokeLinecap="round">
        <path d="M90 58 C 84 48, 80 42, 72 36" />
        <path d="M100 60 C 100 48, 102 40, 108 32" />
      </g>
      {/* raptorial forelegs, raised */}
      <g stroke={color} strokeWidth="4.5" fill="none" strokeLinecap="round">
        <path d="M94 88 C 78 84, 68 76, 64 62 M64 62 C 62 72, 66 80, 74 86" />
        <path d="M100 92 C 116 86, 124 76, 126 64 M126 64 C 130 74, 126 84, 116 90" />
      </g>
      {/* walking legs */}
      <g stroke={color2} strokeWidth="2.2" fill="none" strokeLinecap="round">
        <path d="M98 116 C 82 124, 72 134, 66 148" />
        <path d="M106 122 C 122 130, 132 140, 138 154" />
        <path d="M104 146 C 94 158, 88 166, 84 176" />
      </g>
    </g>
  );
}

function BeeBody({ plate }: { plate: Specimen["plate"] }) {
  const { color, color2 = "#c9a227" } = plate;
  return (
    <g>
      {/* wings */}
      <g fill="#9fb4bd" opacity="0.4">
        <ellipse cx="76" cy="86" rx="26" ry="13" transform="rotate(-28 76 86)" />
        <ellipse cx="124" cy="86" rx="26" ry="13" transform="rotate(28 124 86)" />
      </g>
      {/* fuzzy body */}
      <ellipse cx="100" cy="120" rx="34" ry="42" fill={color} />
      {/* stripes + buff tail */}
      <path d="M67 104 C 78 98, 122 98, 133 104 L 133 116 C 122 110, 78 110, 67 116 Z" fill={color2} />
      <path d="M69 138 C 82 132, 118 132, 131 138 L 129 150 C 118 145, 82 145, 71 150 Z" fill={color2} />
      <path d="M84 156 C 92 162, 108 162, 116 156 C 112 168, 88 168, 84 156 Z" fill="#e9e4c9" />
      {/* head */}
      <circle cx="100" cy="74" r="13" fill="#20241c" />
      <g stroke="#20241c" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M94 64 C 88 54, 84 50, 78 46" />
        <path d="M106 64 C 112 54, 116 50, 122 46" />
      </g>
      {/* legs */}
      <g stroke="#20241c" strokeWidth="2.5" fill="none" strokeLinecap="round">
        <path d="M72 118 C 60 124, 54 130, 50 140" />
        <path d="M128 118 C 140 124, 146 130, 150 140" />
        <path d="M78 146 C 68 156, 64 162, 62 172" />
        <path d="M122 146 C 132 156, 136 162, 138 172" />
      </g>
    </g>
  );
}

const BODIES: Record<Specimen["plate"]["kind"], typeof BeetleBody> = {
  beetle: BeetleBody,
  butterfly: ButterflyBody,
  damselfly: DamselflyBody,
  mantis: MantisBody,
  bee: BeeBody,
};

export interface SpecimenPlateProps {
  specimen: Specimen;
  /** Rendered width/height in px; the plate is square. Defaults to fluid. */
  size?: number;
}

export function SpecimenPlate({ specimen, size }: SpecimenPlateProps) {
  const Body = BODIES[specimen.plate.kind];
  const gradientNeeded = specimen.plate.glow === true;
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={`Illustration of ${specimen.commonName} (${specimen.latinName})`}
      style={size ? undefined : { width: "100%", height: "auto", display: "block" }}
    >
      {gradientNeeded ? (
        <defs>
          <radialGradient id="everframe-glow">
            <stop offset="0%" stopColor="#f4f7ae" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#f4f7ae" stopOpacity="0" />
          </radialGradient>
        </defs>
      ) : null}
      {/* plate ground + archival ring */}
      <rect x="2" y="2" width="196" height="196" rx="10" fill="#fdfdf9" stroke="#d8dacc" />
      <circle cx="100" cy="112" r="76" fill="none" stroke="#eeeee6" strokeWidth="10" />
      {/* mounting pin */}
      <line x1="100" y1="14" x2="100" y2="34" stroke="#8a9082" strokeWidth="1.5" />
      <circle cx="100" cy="13" r="3" fill="#96692b" />
      <Body plate={specimen.plate} />
      {/* catalog tag */}
      <text
        x="14"
        y="188"
        fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
        fontSize="9"
        letterSpacing="1.5"
        fill="#8a9082"
      >
        {specimen.id.toUpperCase()} · {specimen.order.toUpperCase()}
      </text>
    </svg>
  );
}
