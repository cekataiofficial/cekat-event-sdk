using System.Collections.Specialized;
using System.Security.Claims;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Cekat.EventSdk.AzureFunctions.Tests;

internal sealed class TestFunctionContext : FunctionContext
{
    public override string InvocationId { get; } = Guid.NewGuid().ToString();

    public override string FunctionId => "function";

    public override TraceContext TraceContext => throw new NotSupportedException();

    public override BindingContext BindingContext => throw new NotSupportedException();

    public override RetryContext RetryContext => throw new NotSupportedException();

    public override IServiceProvider InstanceServices { get; set; } = null!;

    public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();

    public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();

    public override IInvocationFeatures Features => throw new NotSupportedException();
}

internal sealed class TestHttpRequestData(FunctionContext context, HttpHeadersCollection headers, IReadOnlyCollection<IHttpCookie> cookies) : HttpRequestData(context)
{
    public override Stream Body { get; } = new MemoryStream();

    public override HttpHeadersCollection Headers { get; } = headers;

    public override IReadOnlyCollection<IHttpCookie> Cookies { get; } = cookies;

    public override Uri Url { get; } = new("https://function.test/api/checkout");

    public override IEnumerable<ClaimsIdentity> Identities { get; } = [];

    public override string Method => "POST";

    public override HttpResponseData CreateResponse() => throw new NotSupportedException();
}
