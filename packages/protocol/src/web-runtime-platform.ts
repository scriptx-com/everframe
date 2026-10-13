// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { z } from 'zod';
export const WebRuntimePlatformSchema = z.enum(['web', 'tizen', 'webos', 'vega', 'vidaa', 'titanos']);
export type WebRuntimePlatform = z.infer<typeof WebRuntimePlatformSchema>;
export const ReleaseHealthPlatformSchema = z.enum(['android', 'ios', ...WebRuntimePlatformSchema.options]);
export type ReleaseHealthPlatform = z.infer<typeof ReleaseHealthPlatformSchema>;
/** Runtime identity, not the browser host OS. Generic Android/iOS browsers remain web. */
export function detectWebRuntimePlatform(userAgent: string): WebRuntimePlatform {
  if (/Tizen/i.test(userAgent)) return 'tizen';
  if (/Web0S|webOS|WebAppManager/i.test(userAgent)) return 'webos';
  if (/VIDAA/i.test(userAgent)) return 'vidaa';
  if (/TitanOS/i.test(userAgent)) return 'titanos';
  if (/\bVega(?:\b|OS)/i.test(userAgent)) return 'vega';
  return 'web';
}
