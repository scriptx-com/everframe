# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Derive the native-SDK range from this package's own version, so the JS half
# and the native half always agree. `~> X.Y.Z` means `>= X.Y.Z, < X.(Y+1).0`:
# it blocks cross-minor drift, and it puts a floor at this package's exact
# version.
#
# The floor matters. A range of `~> X.Y.0` is satisfied by X.Y.0 forever, and
# CocoaPods only re-resolves a pod whose `Podfile.lock` entry no longer fits its
# constraint — so upgrading the npm package alone would leave `pod install`
# returning the previously locked native SDK, with nothing in the project
# reporting a mismatch. The floor makes the stale entry unsatisfiable, so the
# ordinary `pod install` picks up the matching native version without needing
# `pod update`.
#
# The Android build (`android/build.gradle.kts`) carries the same floor.
#
# Every release publishes the native SDKs before the npm packages and verifies
# they are fetchable first, so a published `@everframe/react-native@X.Y.Z` always
# has a `Everframe@X.Y.Z` to resolve against.
#
# Local/CI override, mirroring `everframeNativeVersion` on the Android side
# (packages/sdk-react-native/android/build.gradle.kts). It exists for the window
# between a native minor landing and changesets publishing the JS bump that
# matches it — which is EVERY native minor, not an edge case: this package's
# version only moves at release time, so until then the derived range asks for a
# native pod that the workspace no longer contains, and `pod install` cannot
# resolve at all.
#
# Deliberately an env var rather than a file lookup: this podspec is also
# evaluated from inside the published npm tarball at a consumer's install, where
# no workspace path exists. Unset — every consumer install — the derivation
# below is the only source of truth, unchanged.
native_version_override = ENV['EVERFRAME_NATIVE_POD_VERSION'].to_s.strip
native_minor_range = native_version_override.empty? ? '~> 0.9.0' : native_version_override

Pod::Spec.new do |s|
  s.name         = 'EverframeRN'
  s.version      = package['version']
  s.summary      = 'React Native bridge for the Everframe iOS SDK.'
  s.description  = <<~DESC
    iOS half of @everframe/react-native — a thin TurboModule bridge over
    the Everframe iOS SDK. Composes capture from public primitives and delegates
    submit to the SDK.
  DESC
  s.homepage     = 'https://everframe.dev'
  s.license      = { :type => 'MIT', :file => 'LICENSE' }
  s.authors      = { 'ScriptX' => 'eng@scriptx.com' }
  s.source       = { :git => 'https://github.com/scriptx-com/everframe.git', :tag => "v#{s.version}" }

  s.platforms    = { :ios => '15.0', :tvos => '15.0' }
  s.swift_versions = ['5.10']

  s.frameworks   = ['UIKit']
  s.requires_arc = true

  s.source_files = 'ios/Sources/**/*.{h,m,mm,swift}'
  s.public_header_files = 'ios/Sources/EverframeModule.h'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'DEFINES_MODULE' => 'YES',
  }

  if defined?(install_modules_dependencies)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end

  # Published Everframe iOS SDK (CocoaPods Trunk). Range derived from the
  # JS package version (see `native_minor_range` above) so JS and native
  # always agree on the minor.
  s.dependency 'Everframe/Core', native_minor_range
  s.dependency 'Everframe/ReporterUI', native_minor_range

  s.dependency 'React-Core'

  s.test_spec 'Tests' do |t|
    t.source_files = 'ios/Tests/**/*.swift'
    t.frameworks = ['XCTest', 'UIKit']
  end
end
