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
# they are fetchable first, so a published `@traceitx/react-native@X.Y.Z` always
# has a `TraceItX@X.Y.Z` to resolve against.
#
# Local/CI override, mirroring `traceitxNativeVersion` on the Android side
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
native_version_override = ENV['TRACEITX_NATIVE_POD_VERSION'].to_s.strip
native_minor_range = if native_version_override.empty?
  version = package['version'].to_s
  # `~> ` means something DIFFERENT for each component count: `~> 0.6.1` stops
  # at the next minor, but `~> 0.6` stops at the next MAJOR — so a two-component
  # version would silently widen the range to admit 0.7.x, and a four-component
  # one would narrow it to 0.6.1.x and exclude 0.6.2. Neither is the range this
  # file documents, and both are quiet. npm rejects such versions as invalid
  # SemVer, so this only fires on a hand-edited manifest — where failing loudly
  # beats resolving a native SDK nobody chose.
  unless version =~ /\A\d+\.\d+\.\d+(?:[-+].*)?\z/
    raise "TraceItXRN.podspec: package.json version #{version.inspect} is not " \
          'MAJOR.MINOR.PATCH, so the native dependency range cannot be derived. ' \
          'Set TRACEITX_NATIVE_POD_VERSION to pin it explicitly.'
  end
  "~> #{version}"
else
  native_version_override
end

Pod::Spec.new do |s|
  s.name         = 'TraceItXRN'
  s.version      = package['version']
  s.summary      = 'React Native bridge for the TraceItX iOS SDK.'
  s.description  = <<~DESC
    iOS half of @traceitx/react-native — a thin TurboModule bridge over
    the TraceItX iOS SDK. Composes capture from public primitives and delegates
    submit to the SDK.
  DESC
  s.homepage     = 'https://traceitx.com'
  s.license      = { :type => 'MIT', :file => 'LICENSE' }
  s.authors      = { 'ScriptX' => 'eng@scriptx.com' }
  s.source       = { :git => 'https://github.com/scriptx-com/traceitx-releases.git', :tag => "v#{s.version}" }

  s.platforms    = { :ios => '15.0', :tvos => '15.0' }
  s.swift_versions = ['5.10']

  s.frameworks   = ['UIKit']
  s.requires_arc = true

  s.source_files = 'ios/Sources/**/*.{h,m,mm,swift}'
  s.public_header_files = 'ios/Sources/TraceItXModule.h'

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

  # Published TraceItX iOS SDK (CocoaPods Trunk). Range derived from the
  # JS package version (see `native_minor_range` above) so JS and native
  # always agree on the minor.
  s.dependency 'TraceItX/Core', native_minor_range
  s.dependency 'TraceItX/ReporterUI', native_minor_range

  s.dependency 'React-Core'

  s.test_spec 'Tests' do |t|
    t.source_files = 'ios/Tests/**/*.swift'
    t.frameworks = ['XCTest', 'UIKit']
  end
end
