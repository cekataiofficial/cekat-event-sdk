using Cekat.EventSdk;
using Cekat.EventSdk.AzureFunctions;
using Cekat.EventSdk.Internal;
using Microsoft.Azure.Functions.Worker;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>Registers the Cekat event SDK in an Azure Functions isolated worker application.</summary>
public static class CekatFunctionsWorkerExtensions
{
    /// <summary>Resolves the visitor ID of HTTP-triggered invocations for events sent by the function.</summary>
    public static IFunctionsWorkerApplicationBuilder UseCekatVisitor(this IFunctionsWorkerApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var middleware = new CekatFunctionsVisitorMiddleware();
        return builder.Use(next => context => middleware.Invoke(context, next));
    }

    /// <summary>
    /// Registers a singleton <see cref="CekatClient"/>. <paramref name="configure"/> runs immediately and invalid
    /// options throw <see cref="CekatValidationException"/> at startup.
    /// </summary>
    public static IServiceCollection AddCekatEventSdk(this IServiceCollection services, Action<CekatClientOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(services);
        var options = ServiceRegistration.ConfigureAndValidate(configure);
        services.AddSingleton(_ => new CekatClient(options));
        return services;
    }
}
