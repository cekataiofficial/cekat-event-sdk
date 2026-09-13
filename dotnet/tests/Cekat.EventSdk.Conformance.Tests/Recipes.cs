using System.Text;
using System.Text.Json;

namespace Cekat.EventSdk.Conformance.Tests;

internal static class Recipes
{
    /// <summary>Builds the named non-JSON CLR value a fixture asks for.</summary>
    public static object Properties(string name)
    {
        if (name == "cycle")
        {
            var cycle = new Dictionary<string, object?>();
            cycle["self"] = cycle;
            return cycle;
        }

        object value = name switch
        {
            "nan" => double.NaN,
            "positive_infinity" => double.PositiveInfinity,
            "negative_infinity" => double.NegativeInfinity,
            "unsafe_integer_high" => 9_007_199_254_740_992L,
            "unsafe_integer_low" => -9_007_199_254_740_992L,
            "non_string_key" => new Dictionary<int, string> { [1] = "one" },
            "runtime_object" => new object(),
            _ => throw new InvalidOperationException($"unknown properties recipe {name}"),
        };
        return new Dictionary<string, object?> { ["value"] = value };
    }

    public static string ExpandBody(JsonElement recipe)
    {
        var unit = recipe.GetProperty("unit").GetString()!;
        var minimum = recipe.GetProperty("minimum_utf8_bytes").GetInt32();
        var body = new StringBuilder();
        var bytes = 0;
        var unitBytes = Encoding.UTF8.GetByteCount(unit);
        while (bytes < minimum)
        {
            body.Append(unit);
            bytes += unitBytes;
        }

        return body.Append(recipe.GetProperty("suffix").GetString()).ToString();
    }

    /// <summary>Converts literal fixture JSON into ordinary CLR dictionaries, lists, and scalars.</summary>
    public static object? ToClr(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().ToDictionary(property => property.Name, property => ToClr(property.Value)),
        JsonValueKind.Array => element.EnumerateArray().Select(ToClr).ToList(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };
}
