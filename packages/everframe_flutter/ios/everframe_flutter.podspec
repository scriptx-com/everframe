# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
# CocoaPods fallback for this unreleased local plugin; the dry run uses SwiftPM.
Pod::Spec.new do |s|
  s.name = 'everframe_flutter'
  s.version = '0.0.1'
  s.summary = 'Everframe Flutter native bridge dry run'
  s.description = 'Unreleased Flutter native bridge for local feasibility tests.'
  s.homepage = 'https://everframe.dev'
  s.license = { :type => 'MIT' }
  s.author = { 'ScriptX' => 'eng@scriptx.com' }
  s.source = { :path => '.' }
  s.source_files = 'everframe_flutter/Sources/everframe_flutter/**/*.swift'
  s.dependency 'Flutter'
  s.dependency 'Everframe/Core', '~> 0.9.0'
  s.dependency 'Everframe/ReporterUI', '~> 0.9.0'
  s.platform = :ios, '15.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.swift_version = '5.10'
end
