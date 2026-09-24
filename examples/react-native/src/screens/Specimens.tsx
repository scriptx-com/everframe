// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Specimens — catalog grid + in-place detail. Order-filter chips and card
// taps feed tap breadcrumbs; the SVG plates give screenshot capture real
// imagery. Detail view includes a <EverframeSensitive> region so redaction
// can be inspected outside the Profile form too.

import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { EverframeSensitive, useEverframeScreen } from '@everframe/react-native';
import { SpecimenPlate } from '../components/SpecimenPlate';
import { ORDERS, SPECIMENS, type Specimen } from '../data/specimens';
import { color, font, radius, type } from '../theme';

const PLATE_SIZE = Platform.isTV ? 220 : 132;

function SpecimenDetail({
  specimen,
  onBack,
}: {
  specimen: Specimen;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.root}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to catalog"
        testID="specimen-back"
        style={({ pressed, focused }) => [
          styles.backLink,
          (pressed || focused) && styles.backLinkPressed,
        ]}>
        <Text style={styles.backLinkText}>← Catalog</Text>
      </Pressable>

      <View style={styles.detailPlate}>
        <SpecimenPlate specimen={specimen} size={Platform.isTV ? 360 : 240} />
      </View>

      <Text style={type.display} testID="specimen-heading">
        {specimen.commonName}
      </Text>
      <Text style={styles.latin}>{specimen.latinName}</Text>
      <View style={styles.taxonTag}>
        <Text style={styles.taxonTagText}>{specimen.order}</Text>
      </View>

      <View style={styles.facts}>
        {(
          [
            ['Size', specimen.sizeMm],
            ['Habitat', specimen.habitat],
            ['Season', specimen.season],
          ] as const
        ).map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label.toUpperCase()}</Text>
            <Text style={[type.body, styles.factValue]}>{value}</Text>
          </View>
        ))}
      </View>

      <Text style={[type.body, styles.note]}>{specimen.note}</Text>

      <EverframeSensitive>
        <Text style={[type.monoNote, styles.sensitiveNote]} testID="collector-notes">
          Collector’s private note: exact sighting coordinates withheld — this block is wrapped in
          EverframeSensitive and must be masked in captures.
        </Text>
      </EverframeSensitive>
    </View>
  );
}

export function Specimens(): React.JSX.Element {
  useEverframeScreen('Specimens');
  const [order, setOrder] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = selectedId ? SPECIMENS.find((s) => s.id === selectedId) : undefined;
  if (selected) {
    return <SpecimenDetail specimen={selected} onBack={() => setSelectedId(null)} />;
  }

  const shown = order ? SPECIMENS.filter((s) => s.order === order) : SPECIMENS;

  return (
    <View style={styles.root}>
      <Text style={type.eyebrow}>Catalog · {SPECIMENS.length} plates</Text>
      <Text style={[type.display, styles.title]}>Specimens</Text>
      <Text style={[type.muted, styles.lede]}>
        Eight residents of Baltic meadows and old oak woods, drawn as archival plates. Filter by
        order, open a plate for the field notes.
      </Text>

      <View style={styles.chips}>
        {[null, ...ORDERS].map((o) => {
          const isActive = order === o;
          return (
            <Pressable
              key={o ?? 'all'}
              testID={`filter-${(o ?? 'all').toLowerCase()}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              onPress={() => setOrder(o)}
              style={({ pressed, focused }) => [
                styles.chip,
                isActive && styles.chipActive,
                (pressed || focused) && styles.chipFocused,
              ]}>
              <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                {o ?? 'All orders'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.grid} testID="specimen-grid">
        {shown.map((s) => (
          <Pressable
            key={s.id}
            testID={`specimen-${s.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${s.commonName}, ${s.latinName}`}
            onPress={() => setSelectedId(s.id)}
            style={({ pressed, focused }) => [
              styles.gridCard,
              (pressed || focused) && styles.gridCardFocused,
            ]}>
            <SpecimenPlate specimen={s} size={PLATE_SIZE} />
            <Text style={styles.cardName}>{s.commonName}</Text>
            <Text style={styles.cardLatin}>{s.latinName}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingVertical: 8,
  },
  title: {
    marginTop: 8,
  },
  lede: {
    marginTop: 8,
    marginBottom: 14,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  chip: {
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 13,
  },
  chipActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  chipFocused: {
    backgroundColor: color.paperSunken,
  },
  chipText: {
    fontSize: 13,
    color: color.inkSoft,
  },
  chipTextActive: {
    color: color.paper,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  gridCard: {
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: 10,
    alignItems: 'center',
    flexGrow: 1,
    flexBasis: '44%',
  },
  gridCardFocused: {
    backgroundColor: color.paperSunken,
  },
  cardName: {
    fontFamily: font.display,
    fontSize: 16,
    color: color.ink,
    marginTop: 8,
    textAlign: 'center',
  },
  cardLatin: {
    fontSize: 12,
    fontStyle: 'italic',
    color: color.inkSoft,
    marginTop: 2,
    marginBottom: 4,
    textAlign: 'center',
  },
  backLink: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    marginBottom: 6,
  },
  backLinkPressed: {
    backgroundColor: color.paperSunken,
  },
  backLinkText: {
    color: color.mossDeep,
    fontSize: 15,
    fontWeight: '600',
  },
  detailPlate: {
    alignItems: 'center',
    marginBottom: 14,
  },
  latin: {
    fontSize: 16,
    fontStyle: 'italic',
    color: color.inkSoft,
    marginTop: 4,
  },
  taxonTag: {
    alignSelf: 'flex-start',
    backgroundColor: color.tagWash,
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginTop: 8,
  },
  taxonTagText: {
    fontFamily: font.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.tag,
  },
  facts: {
    marginTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineStrong,
  },
  factRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  factLabel: {
    fontFamily: font.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: color.inkFaint,
    width: 84,
    paddingTop: 3,
  },
  factValue: {
    flex: 1,
  },
  note: {
    marginTop: 12,
  },
  sensitiveNote: {
    marginTop: 12,
    backgroundColor: color.paperSunken,
    borderRadius: radius.control,
    padding: 10,
    overflow: 'hidden',
  },
});
