using System.Buffers;
using System.Collections;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cekat.EventSdk.Internal;

/// <summary>Validates an event and writes the ingest request body in one pass, before any request exists.</summary>
internal static class EventPayload
{
    public const long MaximumSafeInteger = 9_007_199_254_740_991;
    private const int MaximumDepth = 128;

    public static byte[] Build(
        string? eventKey,
        bool isCommon,
        EventInput? input,
        string? contextVisitorId,
        Func<DateTimeOffset> now,
        Func<string> newEventId)
    {
        if (string.IsNullOrWhiteSpace(eventKey))
        {
            throw new CekatValidationException("event key must be a non-empty string");
        }

        if (input is null)
        {
            throw new CekatValidationException("event input is required");
        }

        if (string.IsNullOrWhiteSpace(input.Email) && string.IsNullOrWhiteSpace(input.PhoneNumber))
        {
            throw new CekatValidationException("at least one non-empty email or phone number is required");
        }

        foreach (var (name, value) in new[] { ("event key", eventKey), ("email", input.Email), ("phone number", input.PhoneNumber), ("contact name", input.ContactName), ("event ID", input.EventId) })
        {
            if (value is not null && !IsValidUnicode(value))
            {
                throw new CekatValidationException($"{name} must be valid Unicode");
            }
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("event_key", eventKey);
            writer.WriteString("event_id", VisitorIdResolver.Normalize(input.EventId) ?? newEventId());
            writer.WriteString("occurred_at", FormatTimestamp(input.OccurredAt ?? now()));
            writer.WriteBoolean("is_common", isCommon);
            WriteOptional(writer, "email", input.Email);
            WriteOptional(writer, "phone_number", input.PhoneNumber);
            WriteOptional(writer, "contact_name", input.ContactName);
            var visitorId = VisitorIdResolver.Normalize(input.VisitorId) ?? VisitorIdResolver.Normalize(contextVisitorId);
            if (visitorId is not null && IsValidUnicode(visitorId))
            {
                writer.WriteString("visitor_id", visitorId);
            }

            if (input.Properties is not null)
            {
                writer.WritePropertyName("properties");
                WriteProperties(writer, input.Properties);
            }

            writer.WriteEndObject();
        }

        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>Returns a copy of <paramref name="input"/> whose properties include the order_paid arguments.</summary>
    public static EventInput WithOrderPaidProperties(decimal amount, string? currency, EventInput? input)
    {
        if (string.IsNullOrWhiteSpace(currency))
        {
            throw new CekatValidationException("currency must be a non-empty string");
        }

        if (input is null)
        {
            throw new CekatValidationException("event input is required");
        }

        var properties = new List<KeyValuePair<string, object?>>();
        if (input.Properties is not null)
        {
            foreach (var (key, value) in ObjectMembers(input.Properties, "properties"))
            {
                if (key is "amount" or "currency")
                {
                    throw new CekatValidationException($"properties must not contain \"{key}\"; pass it as the OrderPaidAsync argument");
                }

                properties.Add(new KeyValuePair<string, object?>(key, value));
            }
        }

        properties.Add(new KeyValuePair<string, object?>("amount", amount));
        properties.Add(new KeyValuePair<string, object?>("currency", currency));
        return input with { Properties = properties };
    }

    internal static string FormatTimestamp(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return utc.ToString("yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fff'Z'", CultureInfo.InvariantCulture);
    }

    private static void WriteOptional(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is not null)
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteProperties(Utf8JsonWriter writer, object properties)
    {
        var ancestors = new HashSet<object>(ReferenceEqualityComparer.Instance);
        if (properties is JsonElement { ValueKind: not JsonValueKind.Object } or JsonNode and not JsonObject)
        {
            throw new CekatValidationException("properties must be a string-keyed object");
        }

        WriteObject(writer, ObjectMembers(properties, "properties"), properties, "properties", ancestors, 0);
    }

    private static IEnumerable<KeyValuePair<string, object?>> ObjectMembers(object value, string path)
    {
        switch (value)
        {
            case JsonElement { ValueKind: JsonValueKind.Object } element:
                return element.EnumerateObject().Select(property => new KeyValuePair<string, object?>(property.Name, property.Value));
            case JsonObject jsonObject:
                return jsonObject.Select(property => new KeyValuePair<string, object?>(property.Key, property.Value));
            case IEnumerable<KeyValuePair<string, object?>> pairs:
                return pairs;
            case IDictionary dictionary:
                return DictionaryMembers(dictionary, path);
            default:
                throw new CekatValidationException($"{path} must be a string-keyed object");
        }
    }

    private static List<KeyValuePair<string, object?>> DictionaryMembers(IDictionary dictionary, string path)
    {
        var members = new List<KeyValuePair<string, object?>>(dictionary.Count);
        foreach (DictionaryEntry entry in dictionary)
        {
            if (entry.Key is not string key)
            {
                throw new CekatValidationException($"{path} has a non-string key; property keys must be strings");
            }

            members.Add(new KeyValuePair<string, object?>(key, entry.Value));
        }

        return members;
    }

    private static void WriteValue(Utf8JsonWriter writer, object? value, string path, HashSet<object> ancestors, int depth)
    {
        if (depth > MaximumDepth)
        {
            throw new CekatValidationException($"{path} is nested too deeply");
        }

        switch (value)
        {
            case null:
                writer.WriteNullValue();
                return;
            case bool boolean:
                writer.WriteBooleanValue(boolean);
                return;
            case string text:
                if (!IsValidUnicode(text))
                {
                    throw new CekatValidationException($"{path} must be valid Unicode");
                }

                writer.WriteStringValue(text);
                return;
            case sbyte or short or int or long:
                WriteInteger(writer, Convert.ToInt64(value, CultureInfo.InvariantCulture), path);
                return;
            case byte or ushort or uint:
                writer.WriteNumberValue(Convert.ToInt64(value, CultureInfo.InvariantCulture));
                return;
            case ulong unsigned:
                if (unsigned > MaximumSafeInteger)
                {
                    throw Invalid(path);
                }

                writer.WriteNumberValue(unsigned);
                return;
            case float single:
                CheckFloating(single, path);
                writer.WriteNumberValue(single);
                return;
            case double number:
                CheckFloating(number, path);
                writer.WriteNumberValue(number);
                return;
            case decimal money:
                if (decimal.Truncate(money) == money && Math.Abs(money) > MaximumSafeInteger)
                {
                    throw Invalid(path);
                }

                writer.WriteNumberValue(money);
                return;
            case JsonElement element:
                WriteElement(writer, element, path, ancestors, depth);
                return;
            case JsonValue jsonValue:
                WriteElement(writer, ToElement(jsonValue, path), path, ancestors, depth);
                return;
            case JsonArray jsonArray:
                WriteArray(writer, jsonArray, value, path, ancestors, depth);
                return;
            case JsonObject or IDictionary or IEnumerable<KeyValuePair<string, object?>>:
                WriteObject(writer, ObjectMembers(value, path), value, path, ancestors, depth);
                return;
            case IEnumerable sequence:
                WriteArray(writer, sequence.Cast<object?>(), value, path, ancestors, depth);
                return;
            default:
                throw Invalid(path);
        }
    }

    private static void WriteObject(Utf8JsonWriter writer, IEnumerable<KeyValuePair<string, object?>> members, object identity, string path, HashSet<object> ancestors, int depth)
    {
        Enter(identity, path, ancestors);
        writer.WriteStartObject();
        foreach (var (key, item) in members)
        {
            if (key is null || !IsValidUnicode(key))
            {
                throw new CekatValidationException($"{path} has an invalid key; property keys must be valid Unicode strings");
            }

            writer.WritePropertyName(key);
            WriteValue(writer, item, key.Length == 0 ? $"{path}[\"\"]" : $"{path}.{key}", ancestors, depth + 1);
        }

        writer.WriteEndObject();
        ancestors.Remove(identity);
    }

    private static void WriteArray(Utf8JsonWriter writer, IEnumerable<object?> items, object identity, string path, HashSet<object> ancestors, int depth)
    {
        Enter(identity, path, ancestors);
        writer.WriteStartArray();
        var index = 0;
        foreach (var item in items)
        {
            WriteValue(writer, item, $"{path}[{index++}]", ancestors, depth + 1);
        }

        writer.WriteEndArray();
        ancestors.Remove(identity);
    }

    private static void WriteElement(Utf8JsonWriter writer, JsonElement element, string path, HashSet<object> ancestors, int depth)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False or JsonValueKind.String:
                element.WriteTo(writer);
                return;
            case JsonValueKind.Number:
                if (element.TryGetInt64(out var integer))
                {
                    WriteInteger(writer, integer, path);
                    return;
                }

                var raw = element.GetRawText();
                if (raw.AsSpan().IndexOfAny(".eE") < 0 || !element.TryGetDouble(out var number))
                {
                    throw Invalid(path);
                }

                CheckFloating(number, path);
                element.WriteTo(writer);
                return;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                var index = 0;
                foreach (var item in element.EnumerateArray())
                {
                    WriteElementAt(writer, item, $"{path}[{index++}]", ancestors, depth + 1);
                }

                writer.WriteEndArray();
                return;
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject())
                {
                    writer.WritePropertyName(property.Name);
                    WriteElementAt(writer, property.Value, $"{path}.{property.Name}", ancestors, depth + 1);
                }

                writer.WriteEndObject();
                return;
            default:
                throw Invalid(path);
        }
    }

    private static void WriteElementAt(Utf8JsonWriter writer, JsonElement element, string path, HashSet<object> ancestors, int depth)
    {
        if (depth > MaximumDepth)
        {
            throw new CekatValidationException($"{path} is nested too deeply");
        }

        WriteElement(writer, element, path, ancestors, depth);
    }

    private static JsonElement ToElement(JsonValue value, string path)
    {
        try
        {
            var buffer = new ArrayBufferWriter<byte>();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                value.WriteTo(writer);
            }

            using var document = JsonDocument.Parse(buffer.WrittenMemory);
            return document.RootElement.Clone();
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or NotSupportedException or JsonException)
        {
            throw Invalid(path);
        }
    }

    private static void WriteInteger(Utf8JsonWriter writer, long value, string path)
    {
        if (value is > MaximumSafeInteger or < -MaximumSafeInteger)
        {
            throw Invalid(path);
        }

        writer.WriteNumberValue(value);
    }

    private static void CheckFloating(double value, string path)
    {
        if (!double.IsFinite(value) || (Math.Floor(value) == value && Math.Abs(value) > MaximumSafeInteger))
        {
            throw Invalid(path);
        }
    }

    private static void Enter(object identity, string path, HashSet<object> ancestors)
    {
        if (!ancestors.Add(identity))
        {
            throw new CekatValidationException($"{path} contains a cycle");
        }
    }

    private static bool IsValidUnicode(string value)
    {
        for (var index = 0; index < value.Length; index++)
        {
            if (char.IsHighSurrogate(value[index]) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                index++;
            }
            else if (char.IsSurrogate(value[index]))
            {
                return false;
            }
        }

        return true;
    }

    private static CekatValidationException Invalid(string path) => new($"{path} is not a JSON-compatible value");
}
