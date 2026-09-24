# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# DEVELOPMENT podspec for the RN example (and any other in-repo consumer) —
# vendors the xcframeworks built locally by scripts/build-xcframework.sh
# (output lands in ../dist/) instead of downloading the published zip
# from GitHub Releases.
#
# Lives in its own subdir so CocoaPods' `pod 'Everframe', :path =>` picks
# THIS podspec instead of the publishable one at ../Everframe.podspec.
# (Per-dir resolution: CocoaPods chooses `<Name>.podspec` from the given
# `:path`. Two podspecs in the same dir with the same name = ambiguous,
# so we keep them separated.)
#
# Use from the example Podfile with:
#
#   pod 'Everframe', :path => '../../../packages/sdk-ios/dev-podspec'
#
# Then before `pod install`, build the xcframeworks locally:
#
#   cd packages/sdk-ios && ./scripts/build-xcframework.sh
#
# NEVER publish this podspec — it's a workspace-local override. The
# canonical, publishable podspec is ../Everframe.podspec.
# Track the canonical podspec's version so transitive requirements resolve.
# EverframeRN.podspec depends on `Everframe/Core, '~> X.Y.0'` (derived from the
# RN package's own version); a hardcoded version here drifts and breaks
# `pod install` with a "could not find compatible versions" conflict. Note a
# `-dev` prerelease suffix would NOT satisfy `~> X.Y.0` (CocoaPods excludes
# prereleases from non-prerelease requirements), so we use the version as-is.
canonical_version = File.read(File.expand_path("../Everframe.podspec", __dir__))[/spec\.version\s*=\s*"([^"]+)"/, 1]
raise "dev-podspec: could not parse spec.version from ../Everframe.podspec" unless canonical_version

Pod::Spec.new do |spec|
  spec.name         = "Everframe"
  spec.version      = canonical_version
  spec.summary      = "Everframe — workspace dev build (vendors local xcframeworks)."
  spec.description  = <<-DESC
    DEV-ONLY podspec. Wraps the same vendored_frameworks as the published
    ../Everframe.podspec but points at ../dist/*.xcframework so source
    edits in ../Sources/** flow through to the example app after a
    rebuild via ../scripts/build-xcframework.sh.
  DESC
  spec.homepage     = "https://everframe.dev"
  spec.license      = { :type => "MIT", :file => "LICENSE" }
  spec.author       = { "ScriptX" => "engineering@scriptx.com" }

  spec.ios.deployment_target  = "15.0"
  spec.tvos.deployment_target = "15.0"

  # With `:path =>` in the consumer Podfile, CocoaPods uses local files
  # and DOES NOT clone `spec.source`. We still need this attribute set
  # to keep the podspec valid; `:http => 'file://...'` to a non-existent
  # path is the lowest-noise placeholder (no network, no DNS lookup).
  # NEVER ship this podspec — see header comment.
  spec.source = { :http => 'file:///dev/null/never-downloaded.zip' }

  # The `*.xcframework` entries in this dir are symlinks to ../dist/<same>.
  # Mirrors the canonical Everframe.podspec layout (where the extracted zip
  # lands xcframeworks at the same level as the podspec) so CocoaPods'
  # vendored_frameworks evaluation behaves identically — earlier attempts
  # at `dist/X.xcframework` subpaths or `../dist/X.xcframework` parents
  # both produced silent drops (no Pods/<Everframe>/* staging, no
  # FRAMEWORK_SEARCH_PATHS entry in the consumer's xcconfig).
  spec.default_subspecs = ['Core']

  spec.subspec 'Core' do |core|
    core.vendored_frameworks = [
      "EverframeProtocol.xcframework",
      "EverframeKit.xcframework",
    ]
  end

  spec.subspec 'ReporterUI' do |reporter|
    reporter.dependency 'Everframe/Core'
    reporter.vendored_frameworks = "EverframeReporterUI.xcframework"
  end
end
