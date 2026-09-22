# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
Pod::Spec.new do |spec|
  spec.name         = "TraceItX"
  spec.version      = "0.8.2"
  spec.summary      = "AI-readable bug-report SDK for iOS and tvOS."
  spec.description  = <<-DESC
    TraceItX captures structured bug reports (UI tree + console + network +
    screenshot + metadata) and submits them via signed webhooks to your
    ingest service. iOS 15+ / tvOS 15+.
  DESC
  spec.homepage     = "https://traceitx.com"
  spec.license      = { :type => "MIT", :file => "LICENSE" }
  spec.author       = { "ScriptX" => "engineering@scriptx.com" }

  spec.ios.deployment_target  = "15.0"
  spec.tvos.deployment_target = "15.0"

  spec.source = {
    :http => "https://github.com/scriptx-com/traceitx-releases/releases/download/v#{spec.version}/TraceItX-#{spec.version}.zip"
  }

  spec.default_subspecs = ['Core']

  spec.subspec 'Core' do |core|
    # TraceItXProtocol carries wire-format types referenced by TraceItXKit's
    # .swiftinterface; consumers' Swift compiler can't resolve the import
    # without this framework, even though no consumer imports it directly.
    core.vendored_frameworks = ["TraceItXProtocol.xcframework", "TraceItXKit.xcframework"]
  end

  spec.subspec 'ReporterUI' do |reporter|
    reporter.dependency 'TraceItX/Core'
    reporter.vendored_frameworks = "TraceItXReporterUI.xcframework"
  end
end
