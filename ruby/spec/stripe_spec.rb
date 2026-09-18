# frozen_string_literal: true

require "spec_helper"

RSpec.describe CekatEventSdk::Stripe do
  it "validates and trims explicit visitors" do
    expect(described_class.metadata_for_visitor(" visitor_A-1 ")).to eq({ "cekat_visitor_id" => "visitor_A-1" })
    expect(described_class.metadata_for_visitor("a")).to eq({ "cekat_visitor_id" => "a" })
    expect(described_class.metadata_for_visitor("a" * 128)).to eq({ "cekat_visitor_id" => "a" * 128 })
    expect(described_class.metadata_for_visitor("a" * 129)).to eq({})
    expect(described_class.metadata_for_visitor("invalid visitor")).to eq({})
  end

  it "reads the current scope and merges without mutation" do
    CekatEventSdk::VisitorContext.with(" scoped ") do
      expect(described_class.metadata_from_current_visitor).to eq({ "cekat_visitor_id" => "scoped" })
    end
    expect(described_class.metadata_from_current_visitor).to eq({})

    merchant = { "merchant" => "keep", "cekat_visitor_id" => "replace" }
    merged = described_class.merge_metadata(merchant, " visitor_2 ")
    expect(merged).to eq({ "merchant" => "keep", "cekat_visitor_id" => "visitor_2" })
    expect(merchant).to eq({ "merchant" => "keep", "cekat_visitor_id" => "replace" })
    expect(described_class.merge_metadata(merchant, "invalid visitor")).to eq(merchant)
  end
end
