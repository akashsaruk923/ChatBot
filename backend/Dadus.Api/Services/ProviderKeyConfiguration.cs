namespace Dadus.Api.Services;

public static class ProviderKeyConfiguration
{
    private static readonly HashSet<string> Placeholders = new(StringComparer.OrdinalIgnoreCase)
    {
        "YOUR_API_KEY", "YOUR_GEMINI_API_KEY", "YOUR_OPENAI_API_KEY", "YOUR_KEY_HERE",
        "PASTE_YOUR_KEY_LOCALLY", "PASTE_YOUR_API_KEY_HERE", "PASTE_YOUR_KEY_HERE",
        "PASTE_YOUR_GEMINI_KEY_LOCALLY", "PASTE_YOUR_OPENAI_KEY_LOCALLY",
        "ENTER_YOUR_API_KEY_HERE", "REPLACE_WITH_YOUR_API_KEY", "--enter-your-API-key-here--"
    };

    public static string Require(string? value, string providerName)
    {
        // Labels come from a fixed set, never from arbitrary configuration or input.
        var label = providerName.Equals("Gemini", StringComparison.OrdinalIgnoreCase) ? "Gemini"
            : providerName.Equals("OpenAI", StringComparison.OrdinalIgnoreCase) ? "OpenAI"
            : "The selected AI provider";
        if (string.IsNullOrWhiteSpace(value))
            throw new ChatFailure(503, "key_missing", $"{label} access is not configured. Configure its backend API key and restart the API.");
        var key = value.Trim();
        if (Placeholders.Contains(key) || key.Any(character => character <= ' ' || character > '~'))
            throw new ChatFailure(503, "invalid_api_key_configuration",
                $"{label} API key configuration is invalid. Replace any placeholder with the actual key in backend settings, without spaces or non-ASCII characters, then restart the API.");
        return key;
    }
}
