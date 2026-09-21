// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Catalog data for the Elytra demo, ported from examples/react-web so the two
// examples show the same content and a report from either is comparable.
// All species occur in the Baltics; facts are field-guide accurate enough for
// a fixture. Rendered as a simple SVG plate — no binary image assets.
export interface Specimen {
  /** Catalog id — doubles as the route segment (/specimens/:id). */
  id: string;
  commonName: string;
  latinName: string;
  order: string;
  sizeMm: string;
  habitat: string;
  season: string;
  note: string;
  color: string;
}

export const SPECIMENS: Specimen[] = [
  {
    id: 'txx-001',
    commonName: 'Seven-spot ladybird',
    latinName: 'Coccinella septempunctata',
    order: 'Coleoptera',
    sizeMm: '5–8 mm',
    habitat: 'Meadows, gardens, hedgerows',
    season: 'March – October',
    note: 'The classic bug. Adults overwinter in leaf litter and reappear with the first warm days; a single larva eats hundreds of aphids.',
    color: '#b5452f',
  },
  {
    id: 'txx-002',
    commonName: 'Green tiger beetle',
    latinName: 'Cicindela campestris',
    order: 'Coleoptera',
    sizeMm: '12–15 mm',
    habitat: 'Sandy paths, heathland',
    season: 'April – September',
    note: 'One of the fastest insects on the ground for its size. Hunts by sprinting so quickly it briefly blinds itself and must stop to relocate prey.',
    color: '#3e7b57',
  },
  {
    id: 'txx-003',
    commonName: 'Peacock butterfly',
    latinName: 'Aglais io',
    order: 'Lepidoptera',
    sizeMm: '50–55 mm wingspan',
    habitat: 'Woodland edges, gardens',
    season: 'March – October',
    note: 'Four eyespots startle predators; the underside is nearly black, so a resting peacock vanishes against bark.',
    color: '#8a4130',
  },
  {
    id: 'txx-004',
    commonName: 'Common blue damselfly',
    latinName: 'Enallagma cyathigerum',
    order: 'Odonata',
    sizeMm: '32–35 mm',
    habitat: 'Lakes, slow rivers',
    season: 'May – September',
    note: 'Folds its wings along the abdomen at rest — the easy way to tell a damselfly from a dragonfly, which holds them flat.',
    color: '#3e6f9e',
  },
  {
    id: 'txx-005',
    commonName: 'European firefly',
    latinName: 'Lampyris noctiluca',
    order: 'Coleoptera',
    sizeMm: '10–18 mm',
    habitat: 'Damp grassland, forest edges',
    season: 'June – July, after dusk',
    note: 'The wingless female climbs a grass stem and glows to call in flying males. Bioluminescence at ~98% efficiency — no engineer has matched it.',
    color: '#57503c',
  },
  {
    id: 'txx-006',
    commonName: 'European mantis',
    latinName: 'Mantis religiosa',
    order: 'Mantodea',
    sizeMm: '50–75 mm',
    habitat: 'Warm dry grassland',
    season: 'July – October',
    note: 'Expanding north with warming summers; first confirmed Lithuanian records are recent. Turns its head to track you — the only insect that can.',
    color: '#5f7f3f',
  },
  {
    id: 'txx-007',
    commonName: 'Buff-tailed bumblebee',
    latinName: 'Bombus terrestris',
    order: 'Hymenoptera',
    sizeMm: '20–22 mm (queen)',
    habitat: 'Almost everywhere with flowers',
    season: 'February – November',
    note: 'Queens fly in near-freezing air by shivering their flight muscles to 30 °C before takeoff. Buzz-pollinates by gripping a flower and vibrating.',
    color: '#3a3428',
  },
  {
    id: 'txx-008',
    commonName: 'Stag beetle',
    latinName: 'Lucanus cervus',
    order: 'Coleoptera',
    sizeMm: '35–75 mm',
    habitat: 'Old oak woodland, dead wood',
    season: 'June – August, warm evenings',
    note: "Europe's largest beetle. Larvae spend up to six years in rotting oak before one summer of flight; protected across the EU.",
    color: '#4a3526',
  },
];

export function getSpecimen(id: string): Specimen | undefined {
  return SPECIMENS.find((s) => s.id === id);
}
