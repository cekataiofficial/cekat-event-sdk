namespace Cekat.EventSdk.Tests;

public sealed class StripeMetadataTests
{
    [Fact]
    public void ForVisitor_validates_and_trims()
    {
        Assert.Equal("visitor_A-1", StripeMetadata.ForVisitor(" visitor_A-1 ")["cekat_visitor_id"]);
        Assert.Equal("a", StripeMetadata.ForVisitor("a")["cekat_visitor_id"]);
        Assert.Equal(new string('a', 128), StripeMetadata.ForVisitor(new string('a', 128))["cekat_visitor_id"]);
        Assert.Empty(StripeMetadata.ForVisitor(new string('a', 129)));
        Assert.Empty(StripeMetadata.ForVisitor("invalid visitor"));
    }

    [Fact]
    public void FromCurrentVisitor_and_merge_metadata_are_read_only_and_non_mutating()
    {
        using (AsyncLocalVisitorContext.Push(" scoped "))
        {
            Assert.Equal("scoped", StripeMetadata.FromCurrentVisitor()["cekat_visitor_id"]);
        }
        Assert.Empty(StripeMetadata.FromCurrentVisitor());

        var merchant = new Dictionary<string, string> { ["merchant"] = "keep", ["cekat_visitor_id"] = "replace" };
        var merged = StripeMetadata.MergeMetadata(merchant, " visitor_2 ");
        Assert.Equal("keep", merged["merchant"]);
        Assert.Equal("visitor_2", merged["cekat_visitor_id"]);
        Assert.Equal("replace", merchant["cekat_visitor_id"]);
        Assert.Throws<NotSupportedException>(() => ((IDictionary<string, string>)merged).Add("other", "value"));
        Assert.Equal("replace", StripeMetadata.MergeMetadata(merchant, "invalid visitor")["cekat_visitor_id"]);
    }
}
