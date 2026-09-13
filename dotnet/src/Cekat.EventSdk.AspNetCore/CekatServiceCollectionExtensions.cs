using Cekat.EventSdk;
using Cekat.EventSdk.AspNetCore;
using Cekat.EventSdk.Internal;
using Microsoft.AspNetCore.Http;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>Registers the Cekat event SDK in an ASP.NET Core application.</summary>
public static class CekatServiceCollectionExtensions
{
    /// <summary>
    /// Registers a singleton <see cref="CekatClient"/> that reads the request visitor set by
    /// <c>UseCekatVisitor()</c>. <paramref name="configure"/> runs immediately and invalid options throw
    /// <see cref="CekatValidationException"/> at startup.
    /// </summary>
    public static IServiceCollection AddCekatEventSdk(this IServiceCollection services, Action<CekatClientOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(services);
        var options = ServiceRegistration.ConfigureAndValidate(configure);
        services.AddHttpContextAccessor();
        services.AddSingleton(provider => new CekatClient(options, httpClient: null, new AspNetCoreVisitorContext(provider.GetRequiredService<IHttpContextAccessor>())));
        return services;
    }
}
