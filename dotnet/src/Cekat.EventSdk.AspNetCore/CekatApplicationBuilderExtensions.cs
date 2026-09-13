using Cekat.EventSdk.AspNetCore;

namespace Microsoft.AspNetCore.Builder;

/// <summary>Adds the Cekat visitor middleware to an ASP.NET Core pipeline.</summary>
public static class CekatApplicationBuilderExtensions
{
    /// <summary>
    /// Resolves the request's Cekat visitor ID for events sent later in the pipeline. Add it before the
    /// endpoints or middleware that track events.
    /// </summary>
    public static IApplicationBuilder UseCekatVisitor(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.Use(next => new CekatVisitorMiddleware(next).InvokeAsync);
    }
}
