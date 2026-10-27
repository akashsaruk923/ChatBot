using System.Globalization;
using System.Text.Json;

namespace Dadus.Api.Services;

/// <summary>Small, read-only tools available to the server-side agents.</summary>
public static class AgentTools
{
    public static IReadOnlyList<object> Definitions { get; } =
    [
        new
        {
            type = "function",
            function = new
            {
                name = "calculate",
                description = "Calculate a numeric expression using +, -, *, / and parentheses. Expressions are limited to 256 characters; no code or variables are accepted.",
                parameters = new
                {
                    type = "object",
                    properties = new Dictionary<string, object>
                    {
                        ["expression"] = new { type = "string", description = "A decimal arithmetic expression, for example (12 + 3) * 2.", maxLength = 256 }
                    },
                    required = new[] { "expression" },
                    additionalProperties = false
                }
            }
        },
        new
        {
            type = "function",
            function = new
            {
                name = "get_current_time",
                description = "Read the current date and time for a named time zone. The default is Asia/Kolkata.",
                parameters = new
                {
                    type = "object",
                    properties = new Dictionary<string, object>
                    {
                        ["timezone"] = new { type = "string", description = "An IANA time zone such as Asia/Kolkata or Europe/London.", maxLength = 128 }
                    },
                    required = Array.Empty<string>(),
                    additionalProperties = false
                }
            }
        }
    ];

    public static ToolExecution Execute(string name, JsonElement arguments, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var displayName = name is "calculate" or "get_current_time" ? name : "unknown";
        try
        {
            return name switch
            {
                "calculate" => Calculate(arguments, cancellationToken),
                "get_current_time" => CurrentTime(arguments, cancellationToken),
                _ => Error(displayName, "This tool is not available.")
            };
        }
        catch (FormatException error)
        {
            return Error(displayName, error.Message);
        }
        catch (DivideByZeroException)
        {
            return Error(displayName, "Division by zero is not allowed.");
        }
        catch (OverflowException)
        {
            return Error(displayName, "The calculation is outside the supported decimal range.");
        }
        catch (TimeZoneNotFoundException)
        {
            return Error(displayName, "The requested time zone is not available.");
        }
        catch (InvalidTimeZoneException)
        {
            return Error(displayName, "The requested time zone is not available.");
        }
        catch (ArgumentException)
        {
            return Error(displayName, "Tool arguments are invalid.");
        }
        catch (InvalidOperationException)
        {
            return Error(displayName, "Tool arguments are invalid.");
        }
    }

    private static ToolExecution Calculate(JsonElement arguments, CancellationToken cancellationToken)
    {
        ValidateProperties(arguments, "expression");
        if (!arguments.TryGetProperty("expression", out var value) || value.ValueKind != JsonValueKind.String)
            throw new FormatException("Provide an expression as a string.");
        var expression = value.GetString()!;
        var result = CalculationParser.Evaluate(expression, cancellationToken);
        return new("calculate", $"{expression.Trim()} = {result.ToString("0.############################", CultureInfo.InvariantCulture)}");
    }

    private static ToolExecution CurrentTime(JsonElement arguments, CancellationToken cancellationToken)
    {
        ValidateProperties(arguments, "timezone");
        var zoneName = "Asia/Kolkata";
        if (arguments.TryGetProperty("timezone", out var value))
        {
            if (value.ValueKind != JsonValueKind.String)
                throw new FormatException("Provide the time zone as a string.");
            zoneName = value.GetString()!.Trim();
            if (zoneName.Length is < 1 or > 128)
                throw new FormatException("Provide a time zone between 1 and 128 characters.");
        }
        cancellationToken.ThrowIfCancellationRequested();
        var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneName);
        var now = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone);
        return new("get_current_time", $"{now.ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture)} ({zoneName})");
    }

    private static void ValidateProperties(JsonElement arguments, string allowed)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
            throw new FormatException("Tool arguments must be a JSON object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in arguments.EnumerateObject())
        {
            if (property.Name != allowed || !seen.Add(property.Name))
                throw new FormatException("Tool arguments contain unsupported or duplicate fields.");
        }
    }

    private static ToolExecution Error(string name, string message) => new(name, "Tool error: " + message);
}
