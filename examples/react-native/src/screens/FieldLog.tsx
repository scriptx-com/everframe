// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Field log — the long-scroll tab. One SectionList carries an interactive
// "Your log" section (add / confirm / delete — DOM mutations for replay)
// followed by 140 deterministic archive records under sticky month headers,
// mirroring the web example's /log + /archive pages. This screen owns its
// scrolling, so App.tsx must NOT wrap it in a ScrollView.

import React, { useCallback, useState } from 'react';
import {
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTXScreen } from '@traceitx/react-native';
import { ARCHIVE, ARCHIVE_TOTAL, type ArchiveRecord } from '../data/archive';
import { SPECIMENS } from '../data/specimens';
import { color, font, radius, type } from '../theme';

interface LogEntry {
  id: string;
  note: string;
  site: string;
  confirmed: boolean;
}

const SEED_ENTRIES: LogEntry[] = [
  {
    id: 'seed-1',
    note: 'Two ladybirds on the office windowsill — the dogfood kind of bug.',
    site: 'Vilnius, office',
    confirmed: true,
  },
  {
    id: 'seed-2',
    note: 'Faint green glow by the path after dusk. Almost certainly Lampyris.',
    site: 'Neris riverbank',
    confirmed: false,
  },
  {
    id: 'seed-3',
    note: 'Something large buzzed past the balcony. Stag beetle? Log and verify.',
    site: 'Užupis, balcony',
    confirmed: false,
  },
];

type Row = { kind: 'log'; entry: LogEntry } | { kind: 'archive'; record: ArchiveRecord };

export function FieldLog(): React.JSX.Element {
  useTXScreen('FieldLog');
  const [entries, setEntries] = useState<LogEntry[]>(SEED_ENTRIES);
  const [note, setNote] = useState('');

  const addEntry = useCallback(() => {
    const trimmed = note.trim();
    if (!trimmed) return;
    setEntries((prev) => [
      {
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        note: trimmed,
        site: 'Added in app',
        confirmed: false,
      },
      ...prev,
    ]);
    setNote('');
  }, [note]);

  const toggle = useCallback((id: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, confirmed: !e.confirmed } : e)));
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const sections = [
    {
      title: 'Your log',
      count: `${entries.length} entries`,
      data: entries.map<Row>((entry) => ({ kind: 'log', entry })),
    },
    ...ARCHIVE.map((month) => ({
      title: month.title,
      count: `${month.data.length} records`,
      data: month.data.map<Row>((record) => ({ kind: 'archive', record })),
    })),
  ];

  return (
    <SectionList<Row, { title: string; count: string }>
      style={styles.list}
      contentContainerStyle={styles.content}
      sections={sections}
      // Deliberately OFF: sticky headers route through ScrollView's
      // Animated/Paper-renderer path, and under react-native-tvos@0.85.3-0
      // bridgeless the Paper shim is absent — enabling this crashes the tab
      // with "Cannot read property 'default' of undefined"
      // (RendererImplementation.getPaperRenderer). Verified on emulator.
      stickySectionHeadersEnabled={false}
      keyExtractor={(row) => (row.kind === 'log' ? row.entry.id : row.record.id)}
      testID="log-list"
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={type.eyebrow}>
            Observations · {ARCHIVE_TOTAL} archive records · 12 months
          </Text>
          <Text style={[type.display, styles.title]}>Field log</Text>
          <Text style={[type.muted, styles.lede]}>
            What you saw, where. Below your live log sits two seasons of archive — scroll deep,
            the replay recorder is watching.
          </Text>
          <View style={styles.addRow}>
            <TextInput
              testID="log-input"
              accessibilityLabel="Observation note"
              style={styles.input}
              placeholder="What did you see?"
              placeholderTextColor={color.inkFaint}
              value={note}
              onChangeText={setNote}
              onSubmitEditing={addEntry}
              returnKeyType="done"
            />
            <Pressable
              testID="log-add"
              accessibilityRole="button"
              accessibilityLabel="Add entry"
              onPress={addEntry}
              style={({ pressed, focused }) => [
                styles.addButton,
                (pressed || focused) && styles.addButtonPressed,
              ]}>
              <Text style={styles.addButtonText}>Add</Text>
            </Pressable>
          </View>
        </View>
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <Text style={styles.sectionCount}>{section.count.toUpperCase()}</Text>
        </View>
      )}
      renderItem={({ item }) =>
        item.kind === 'log' ? (
          <View style={styles.logRow}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.entry.confirmed }}
              accessibilityLabel={`Confirm: ${item.entry.note}`}
              onPress={() => toggle(item.entry.id)}
              style={({ pressed, focused }) => [
                styles.checkbox,
                item.entry.confirmed && styles.checkboxChecked,
                (pressed || focused) && styles.rowFocused,
              ]}>
              {item.entry.confirmed ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </Pressable>
            <View style={styles.logBody}>
              <Text
                style={[type.body, item.entry.confirmed && styles.logNoteConfirmed]}
                numberOfLines={3}>
                {item.entry.note}
              </Text>
              <Text style={type.monoNote}>{item.entry.site}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete: ${item.entry.note}`}
              onPress={() => remove(item.entry.id)}
              style={({ pressed, focused }) => [
                styles.deleteButton,
                (pressed || focused) && styles.rowFocused,
              ]}>
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.archiveRow}>
            <Text style={styles.archiveDay}>{item.record.dayLabel}</Text>
            <View style={styles.archiveBody}>
              <Text style={type.body}>
                {SPECIMENS[item.record.specimenIdx].commonName}
                {item.record.count > 1 ? (
                  <Text style={styles.archiveCount}> ×{item.record.count}</Text>
                ) : null}
              </Text>
              <Text style={type.monoNote}>
                {item.record.site} · {item.record.weather} · {item.record.observer}
              </Text>
            </View>
          </View>
        )
      }
      ListFooterComponent={
        <Text style={[type.monoNote, styles.footer]}>
          End of archive — {ARCHIVE_TOTAL} records shown.
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 120,
  },
  header: {
    paddingTop: 8,
    paddingBottom: 4,
  },
  title: {
    marginTop: 8,
  },
  lede: {
    marginTop: 8,
    marginBottom: 14,
  },
  addRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: Platform.isTV ? 12 : 9,
    backgroundColor: color.paperRaised,
    color: color.ink,
    fontSize: 14,
  },
  addButton: {
    backgroundColor: color.moss,
    borderRadius: radius.control,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addButtonPressed: {
    backgroundColor: color.mossDeep,
  },
  addButtonText: {
    color: '#FBFCF8',
    fontSize: 14,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.lineStrong,
    paddingVertical: 8,
    marginTop: 14,
  },
  sectionTitle: {
    fontFamily: font.display,
    fontSize: 18,
    color: color.ink,
  },
  sectionCount: {
    fontFamily: font.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: color.inkFaint,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  rowFocused: {
    opacity: 0.7,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    backgroundColor: color.paperRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: color.moss,
    borderColor: color.mossDeep,
  },
  checkboxMark: {
    color: '#FBFCF8',
    fontSize: 13,
    fontWeight: '700',
  },
  logBody: {
    flex: 1,
    gap: 2,
  },
  logNoteConfirmed: {
    color: color.inkFaint,
    textDecorationLine: 'line-through',
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: '#D8B0A6',
    borderRadius: radius.control,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  deleteText: {
    color: color.danger,
    fontSize: 12,
    fontWeight: '600',
  },
  archiveRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  archiveDay: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.inkFaint,
    width: 52,
    paddingTop: 3,
  },
  archiveBody: {
    flex: 1,
    gap: 1,
  },
  archiveCount: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.tag,
  },
  footer: {
    marginTop: 20,
    textAlign: 'center',
  },
});
