// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Canonical `react-native` mock used by every unit test in this package.
// The vitest.config.ts → resolve.alias entry points `react-native` at
// __tests__/stubs/react-native.ts; this vi.mock then overrides
// TurboModuleRegistry.getEnforcing to return the D-05 methods (plus Task 14's
// addBreadcrumb, the reportCrash sync method (spec 2026-07-18), and setUser
// (spec 2026-08-12)) as vi.fn() stubs, so spec-shape tests can introspect the
// surface without booting RN.
import { vi } from "vitest";

// Pass-through stubs for any RN primitive a JSX file may import at module load
// time. The provider/modal/preview files only USE these during render — they
// never call into them at import — so returning a no-op identity for `create`
// and string-tagged placeholders for components is sufficient for unit-test
// imports (the rendering itself is exercised by 06-06 Maestro smoke).
const passthrough = (name: string) =>
  Object.assign(() => null, { displayName: name });

vi.mock("react-native", () => ({
  TurboModuleRegistry: {
    getEnforcing: () => ({
      configure: vi.fn(),
      configureSync: vi.fn(() => true),
      openReporter: vi.fn().mockResolvedValue({ status: "cancelled" }),
      registerSensitiveRect: vi.fn(),
      setExtra: vi.fn(),
      setExtraResolverActive: vi.fn(),
      signalExtraResolverReady: vi.fn(),
      addBreadcrumb: vi.fn(),
      recordScreen: vi.fn(),
      reportCrash: vi.fn().mockReturnValue(true),
      captureHandledException: vi.fn().mockReturnValue(true),
      setUser: vi.fn(),
      trackPlayer: vi.fn(),
      detachPlayer: vi.fn(),
      recordPlayerEvent: vi.fn(),
      updatePlayerStats: vi.fn(),
      trackVitals: vi.fn(),
    }),
  },
  // `Platform` is read at module scope by companion.ts and by the
  // react-native-video adapter (the onBandwidthUpdate platform split), so the
  // mock must carry it. iOS is the default; adapters take an explicit
  // `platform` option in tests that need the Android path.
  Platform: {
    OS: "ios",
    isTV: false,
    select: (o: Record<string, unknown>) => o.ios ?? o.default,
  },
  requireNativeComponent: (name: string) => passthrough(name),
  // UI primitives — components are no-op functional components for unit tests.
  View: passthrough("View"),
  Text: passthrough("Text"),
  TextInput: passthrough("TextInput"),
  Pressable: passthrough("Pressable"),
  Image: passthrough("Image"),
  ScrollView: passthrough("ScrollView"),
  FlatList: passthrough("FlatList"),
  Modal: passthrough("Modal"),
  ActivityIndicator: passthrough("ActivityIndicator"),
  // StyleSheet.create is a pass-through identity at runtime (RN returns the
  // same object keyed by string id; behaviour we don't exercise in unit tests).
  StyleSheet: {
    create: <T>(styles: T): T => styles,
    hairlineWidth: 1,
  },
}));
