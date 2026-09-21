// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * Catalog data for the Elytra demo — same catalog as examples/react-web
 * (app/lib/specimens.ts); keep the two in sync. Rendered as generative SVG
 * by <SpecimenPlate/> (react-native-svg) — the example ships zero binary
 * image assets.
 */

export type PlateKind = "beetle" | "butterfly" | "damselfly" | "mantis" | "bee";

export interface Specimen {
  /** Catalog id — doubles as the route segment (/specimens/[id]). */
  id: string;
  commonName: string;
  latinName: string;
  order: string;
  sizeMm: string;
  habitat: string;
  season: string;
  note: string;
  plate: {
    kind: PlateKind;
    /** Body / forewing colour. */
    color: string;
    /** Stripe or hindwing colour (kind-dependent). */
    color2?: string;
    spots?: number;
    glow?: boolean;
    mandibles?: boolean;
  };
}

export const SPECIMENS: Specimen[] = [
  {
    id: "txx-001",
    commonName: "Seven-spot ladybird",
    latinName: "Coccinella septempunctata",
    order: "Coleoptera",
    sizeMm: "5–8 mm",
    habitat: "Meadows, gardens, hedgerows",
    season: "March – October",
    note: "The classic bug. Adults overwinter in leaf litter and reappear with the first warm days; a single larva eats hundreds of aphids.",
    plate: { kind: "beetle", color: "#b5452f", color2: "#20241c", spots: 7 },
  },
  {
    id: "txx-002",
    commonName: "Green tiger beetle",
    latinName: "Cicindela campestris",
    order: "Coleoptera",
    sizeMm: "12–15 mm",
    habitat: "Sandy paths, heathland",
    season: "April – September",
    note: "One of the fastest insects on the ground for its size. Hunts by sprinting so quickly it briefly blinds itself and must stop to relocate prey.",
    plate: { kind: "beetle", color: "#3e7b57", color2: "#e9e4c9", spots: 4 },
  },
  {
    id: "txx-003",
    commonName: "Peacock butterfly",
    latinName: "Aglais io",
    order: "Lepidoptera",
    sizeMm: "50–55 mm wingspan",
    habitat: "Woodland edges, gardens",
    season: "March – October",
    note: "Four eyespots startle predators; the underside is nearly black, so a resting peacock vanishes against bark.",
    plate: { kind: "butterfly", color: "#8a4130", color2: "#3e5f8a" },
  },
  {
    id: "txx-004",
    commonName: "Common blue damselfly",
    latinName: "Enallagma cyathigerum",
    order: "Odonata",
    sizeMm: "32–35 mm",
    habitat: "Lakes, slow rivers",
    season: "May – September",
    note: "Folds its wings along the abdomen at rest — the easy way to tell a damselfly from a dragonfly, which holds them flat.",
    plate: { kind: "damselfly", color: "#3e6f9e", color2: "#20241c" },
  },
  {
    id: "txx-005",
    commonName: "European firefly",
    latinName: "Lampyris noctiluca",
    order: "Coleoptera",
    sizeMm: "10–18 mm",
    habitat: "Damp grassland, forest edges",
    season: "June – July, after dusk",
    note: "The wingless female climbs a grass stem and glows to call in flying males. Bioluminescence at ~98% efficiency — no engineer has matched it.",
    plate: { kind: "beetle", color: "#57503c", color2: "#3d3729", glow: true },
  },
  {
    id: "txx-006",
    commonName: "European mantis",
    latinName: "Mantis religiosa",
    order: "Mantodea",
    sizeMm: "50–75 mm",
    habitat: "Warm dry grassland",
    season: "July – October",
    note: "Expanding north with warming summers; first confirmed Lithuanian records are recent. Turns its head to track you — the only insect that can.",
    plate: { kind: "mantis", color: "#5f7f3f", color2: "#8aa35e" },
  },
  {
    id: "txx-007",
    commonName: "Buff-tailed bumblebee",
    latinName: "Bombus terrestris",
    order: "Hymenoptera",
    sizeMm: "20–22 mm (queen)",
    habitat: "Almost everywhere with flowers",
    season: "February – November",
    note: "Queens fly in near-freezing air by shivering their flight muscles to 30 °C before takeoff. Buzz-pollinates by gripping a flower and vibrating.",
    plate: { kind: "bee", color: "#3a3428", color2: "#c9a227" },
  },
  {
    id: "txx-008",
    commonName: "Stag beetle",
    latinName: "Lucanus cervus",
    order: "Coleoptera",
    sizeMm: "35–75 mm",
    habitat: "Old oak woodland, dead wood",
    season: "June – August, warm evenings",
    note: "Europe's largest beetle. Larvae spend up to six years in rotting oak before one summer of flight; protected across the EU.",
    plate: { kind: "beetle", color: "#4a3526", color2: "#6e4a2f", mandibles: true },
  },
];

export const ORDERS = [...new Set(SPECIMENS.map((s) => s.order))];

export function getSpecimen(id: string): Specimen | undefined {
  return SPECIMENS.find((s) => s.id === id);
}
