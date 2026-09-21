# frozen_string_literal: true

require "spec_helper"
require "open3"
require "tmpdir"

RSpec.describe "scripts/package" do
  script = File.expand_path("../scripts/package", __dir__)

  it "rejects invalid arguments before running checks" do
    Dir.mktmpdir do |dirty|
      File.write(File.join(dirty, "stale.gem"), "stale")
      [
        [],
        ["--version", "0.2.0"],
        ["--version", "0.1.1", "--output", Dir.tmpdir],
        ["--version", "0.2.0", "--output", "relative"],
        ["--version", "0.2.0", "--output", "#{Dir.tmpdir}/../tmp"],
        ["--version", "0.2.0", "--output", dirty],
        ["--version", "0.2.0", "--output", File.expand_path("../pkg-output", __dir__)]
      ].each do |arguments|
        output, status = Open3.capture2e(RbConfig.ruby, script, *arguments)
        expect(status.exitstatus).to eq(2), "#{arguments.inspect}: #{output}"
        expect(output).to include("usage")
      end
    end
  end

  it "matches the gem version and never publishes" do
    source = File.read(script)
    expect(source).to include(%(VERSION = "#{CekatEventSdk::VERSION}"))
    ["rake\", \"spec", "rubocop", "bundle-audit", "gem\", \"build"].each { |required| expect(source).to include(required) }
    ["gem push", "\"push\"", "gem signin", "git tag", "git push"].each { |forbidden| expect(source).not_to include(forbidden) }
  end
end
