// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

// The camera prompt is a separate fixture case. Put its permission exclusively
// in Android's debug source set, so even an opted-in prebuild cannot add it to Release.
module.exports = (config) =>
  withDangerousMod(config, [
    'android',
    async (mod) => {
      const file = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/debug/AndroidManifest.xml',
      );
      let xml;
      try {
        xml = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        xml =
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n</manifest>\n';
      }
      xml = xml.replace(
        /\s*<!-- EVERFRAME_INTERACTION_FIXTURE_PERMISSION -->\s*<uses-permission android:name="android.permission.CAMERA" \/>/g,
        '',
      );
      if (
        process.env.EXPO_PUBLIC_EVERFRAME_INTERACTION_FIXTURE === '1' &&
        process.env.EXPO_TV !== '1' &&
        !xml.includes('android.permission.CAMERA')
      ) {
        xml = xml.replace(
          '</manifest>',
          '    <!-- EVERFRAME_INTERACTION_FIXTURE_PERMISSION -->\n    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>',
        );
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, xml);
      return mod;
    },
  ]);
