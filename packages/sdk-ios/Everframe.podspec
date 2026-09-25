# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
Pod::Spec.new do |spec|
  spec.name         = "Everframe"
  spec.version      = "0.9.0"
  spec.summary      = "AI-readable bug-report SDK for iOS and tvOS."
  spec.description  = <<-DESC
    Everframe captures structured bug reports (UI tree + console + network +
    screenshot + metadata) and submits them via signed webhooks to your
    ingest service. iOS 15+ / tvOS 15+.
  DESC
  spec.homepage     = "https://everframe.dev"
  spec.license      = { :type => "MIT", :file => "LICENSE" }
  spec.author       = { "ScriptX" => "engineering@scriptx.com" }

  spec.ios.deployment_target  = "15.0"
  spec.tvos.deployment_target = "15.0"

  spec.source = {
    :http => "https://github.com/scriptx-com/everframe/releases/download/v#{spec.version}/Everframe-#{spec.version}.zip"
  }

  spec.default_subspecs = ['Core']

  spec.subspec 'Core' do |core|
    # EverframeProtocol carries wire-format types referenced by EverframeKit's
    # .swiftinterface; consumers' Swift compiler can't resolve the import
    # without this framework, even though no consumer imports it directly.
    core.vendored_frameworks = ["EverframeProtocol.xcframework", "EverframeKit.xcframework"]
  end

  spec.subspec 'ReporterUI' do |reporter|
    reporter.dependency 'Everframe/Core'
    reporter.vendored_frameworks = "EverframeReporterUI.xcframework"
  end
end
