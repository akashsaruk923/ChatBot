using System.Text.Json;
using System.Text.Json.Nodes;

namespace Dadus.Api.Services;

internal sealed record ChatProviderProfile(string Mode, string DisplayName, string ConfigurationSection,
    string Endpoint, string DefaultModel)
{
    public static ChatProviderProfile OpenAI { get; } = new("openai", "OpenAI", "DadusOpenAI",
        "https://api.openai.com/v1/chat/completions", "gpt-4o-mini");
    public static ChatProviderProfile Gemini { get; } = new("gemini", "Gemini", "DadusGemini",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", GeminiChatResponder.DefaultModel);

    private static readonly JsonNode GeminiTools = CreateGeminiTools();

    public Dictionary<string, object?> CreatePayload(string model, IReadOnlyList<object> messages, bool noTools)
    {
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = messages,
            ["tools"] = Mode == "gemini" ? GeminiTools : AgentTools.Definitions,
            ["tool_choice"] = noTools ? "none" : "auto"
        };
        if (Mode == "gemini")
        {
            // The compatibility endpoint supports max_tokens. Reserve room for the
            // model's thinking and visible reply without forwarding OpenAI-only options.
            payload["max_tokens"] = 4096;
            payload["reasoning_effort"] = "low";
        }
        else
        {
            payload["parallel_tool_calls"] = false;
            payload["max_completion_tokens"] = 1024;
            payload["store"] = false;
        }
        return payload;
    }

    private static JsonNode CreateGeminiTools()
    {
        var tools = JsonSerializer.SerializeToNode(AgentTools.Definitions)!.AsArray();
        foreach (var tool in tools)
        {
            var parameters = tool!["function"]!["parameters"]!.AsObject();
            // Use the common schema subset. Execution still enforces property,
            // string-length and expression limits for both providers on the server.
            parameters.Remove("additionalProperties");
            foreach (var property in parameters["properties"]!.AsObject())
                property.Value!.AsObject().Remove("maxLength");
        }
        return tools;
    }
}
