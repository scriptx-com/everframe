# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
# CocoaPods integration for Flutter hosts that do not use SwiftPM.
Pod::Spec.new do |s|
  s.name = 'everframe_flutter'
  s.version = '1.0.0'
  s.summary = 'Everframe Flutter native bridge'
  s.description = 'Flutter bridge for the Everframe Android and iOS SDKs.'
  s.homepage = 'https://everframe.dev'
  s.license = { :type => 'MIT' }
  s.author = { 'ScriptX' => 'eng@scriptx.com' }
  s.source = { :path => '.' }
  s.source_files = 'everframe_flutter/Sources/everframe_flutter/**/*.swift'
  s.dependency 'Flutter'
  # The plugin calls EverframeConfig(sdkKey:), which first ships in native 1.2.0.
  s.dependency 'Everframe/Core', '~> 1.2.0'
  s.dependency 'Everframe/ReporterUI', '~> 1.2.0'
  s.platform = :ios, '15.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.10'
end
