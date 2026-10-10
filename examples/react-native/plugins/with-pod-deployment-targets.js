// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Xcode 27 builds no iOS or tvOS target below 15.0. React Native's
// react_native_post_install raises every pod target to its minimum, but not the
// resource bundle targets CocoaPods creates beside them: react-native-svg's
// RNSVG-RNSVGFilters keeps the 12.4 its podspec declares and fails the build.
// This raises any lower deployment target in the Pods project to React
// Native's own minimum.

const { withPodfile } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const RAISE_DEPLOYMENT_TARGETS = `    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        %w[IPHONEOS_DEPLOYMENT_TARGET TVOS_DEPLOYMENT_TARGET].each do |key|
          current = build_configuration.build_settings[key]
          if current && Gem::Version.new(current) < Gem::Version.new(min_ios_version_supported)
            build_configuration.build_settings[key] = min_ios_version_supported
          end
        end
      end
    end`;

module.exports = (config) =>
  withPodfile(config, (podfile) => {
    const merged = mergeContents({
      tag: 'everframe-pod-deployment-targets',
      src: podfile.modResults.contents,
      newSrc: RAISE_DEPLOYMENT_TARGETS,
      anchor: /^\s*react_native_post_install\(/m,
      offset: 0,
      comment: '#',
    });
    if (!merged.didMerge && !merged.didClear && !podfile.modResults.contents.includes('everframe-pod-deployment-targets'))
      throw new Error('with-pod-deployment-targets: no react_native_post_install call in the Podfile');
    podfile.modResults.contents = merged.contents;
    return podfile;
  });
