using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Dadus.Api.Services;

internal sealed class CompatibleChatResponder(HttpClient httpClient, IConfiguration configuration, ChatProviderProfile provider) : IChatResponder
{
    private const int MaxRounds = 4;
    private const int MaxToolCalls = 4;
    private const int MaxResponseBytes = 128 * 1024;
    public string Mode => provider.Mode;

    public async Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        (await RunAgentAsync("companion", context, cancellationToken)).Content;

    public async Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = AgentCatalog.Get(agentId);
        var key = ProviderKeyConfiguration.Require(configuration[$"{provider.ConfigurationSection}:ApiKey"], provider.DisplayName);
        var messages = BuildContext(agentId, context);
        var executions = new List<ToolExecution>();
        var callIds = new HashSet<string>(StringComparer.Ordinal);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        var token = deadline.Token;
        try
        {
            for (var round = 0; round < MaxRounds; round++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, provider.Endpoint);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                request.Content = JsonContent.Create(provider.CreatePayload(
                    configuration[$"{provider.ConfigurationSection}:Model"] ?? provider.DefaultModel,
                    messages, round == MaxRounds - 1 || executions.Count >= MaxToolCalls));
                using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if (!response.IsSuccessStatusCode)
                    throw await ProviderFailureAsync(response, token);
                using var document = await ReadResponseAsync(response, token);
                var (message, finishReason) = ReadAssistantMessage(document.RootElement);
                var calls = ReadToolCalls(message, callIds);
                if ((finishReason == "stop" && calls.Count != 0) ||
                    (finishReason == "tool_calls" && calls.Count == 0))
                    throw InvalidResponse();
                if (calls.Count == 0)
                {
                    if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.String)
                        throw InvalidResponse();
                    var text = content.GetString()?.Trim();
                    if (string.IsNullOrWhiteSpace(text) || text.Length > 12000) throw InvalidResponse();
                    return new AgentReply(text, executions.ToArray());
                }
                if (round == MaxRounds - 1 || executions.Count + calls.Count > MaxToolCalls)
                    throw LimitExceeded();

                // Retain protocol fields only. Gemini also needs its opaque signature to
                // continue a tool call; it is never displayed, logged or persisted.
                messages.Add(new
                {
                    role = "assistant",
                    content = (string?)null,
                    tool_calls = calls.Select(SerializeToolCall).ToArray()
                });
                foreach (var call in calls)
                {
                    token.ThrowIfCancellationRequested();
                    ToolExecution execution;
                    try
                    {
                        using var arguments = JsonDocument.Parse(call.Arguments, new JsonDocumentOptions { MaxDepth = 16 });
                        execution = AgentTools.Execute(call.Name, arguments.RootElement, token);
                    }
                    catch (JsonException)
                    {
                        execution = new ToolExecution(call.Name is "calculate" or "get_current_time" ? call.Name : "unknown", "Tool error: Arguments must be a valid JSON object.");
                    }
                    executions.Add(execution);
                    messages.Add(new
                    {
                        role = "tool",
                        tool_call_id = call.Id,
                        content = JsonSerializer.Serialize(new { result = execution.Summary })
                    });
                }
            }
            throw LimitExceeded();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ChatFailure(504, "provider_timeout", $"{provider.DisplayName} took too long to respond. Please try again.");
        }
        catch (HttpRequestException error)
        {
            throw error.HttpRequestError switch
            {
                HttpRequestError.NameResolutionError => new ChatFailure(502, "provider_dns_failed",
                    $"{provider.DisplayName} host name could not be resolved. Check the backend machine's DNS and internet connection."),
                HttpRequestError.ConnectionError => new ChatFailure(502, "provider_connection_failed",
                    $"{provider.DisplayName} connection failed. Check the backend machine's network, firewall and proxy settings."),
                HttpRequestError.SecureConnectionError => new ChatFailure(502, "provider_tls_failed",
                    $"{provider.DisplayName} HTTPS certificate or TLS connection failed. Check the backend machine's clock and certificate trust."),
                HttpRequestError.ProxyTunnelError => new ChatFailure(502, "provider_proxy_failed",
                    $"The backend proxy could not connect to {provider.DisplayName}. Check its proxy configuration."),
                _ => new ChatFailure(502, "provider_unavailable", $"{provider.DisplayName} is unavailable. Please try again later.")
            };
        }
        catch (JsonException)
        {
            throw InvalidResponse();
        }
    }

    private static List<object> BuildContext(string agentId, IReadOnlyList<ChatTurn> context)
    {
        if (context.Any(turn => turn.Role is not ("user" or "assistant") || turn.Content is null))
            throw new ChatFailure(400, "invalid_context", "The conversation context is invalid.");
        var selected = new List<ChatTurn>();
        var characters = 0;
        foreach (var turn in context.Reverse().Take(21))
        {
            if (turn.Content.Length > 12000)
                throw new ChatFailure(400, "invalid_context", "The conversation context is too large.");
            if (characters + turn.Content.Length > 32000) break;
            characters += turn.Content.Length;
            selected.Add(turn);
        }
        selected.Reverse();
        var messages = new List<object> { new { role = "system", content = AgentCatalog.Instructions(agentId) } };
        messages.AddRange(selected.Select(turn => (object)new { role = turn.Role, content = turn.Content }));
        return messages;
    }

    private static (JsonElement Message, string FinishReason) ReadAssistantMessage(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("choices", out var choices) ||
            choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0 ||
            choices[0].ValueKind != JsonValueKind.Object ||
            !ReadString(choices[0], "finish_reason", 32, out var finishReason))
            throw InvalidResponse();
        // Truncated or filtered output is never a completed exchange, even if it contains text
        // or apparently valid tool arguments. Validate this before parsing/executing any calls.
        if (finishReason is "length" or "content_filter")
            throw new ChatFailure(502, "incomplete_provider_response", "The AI provider did not finish its response. Please try again.");
        if (finishReason is not ("stop" or "tool_calls") ||
            !choices[0].TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)
            throw InvalidResponse();
        return (message, finishReason);
    }

    private sealed record FunctionCall(string Id, string Name, string Arguments, string? ThoughtSignature);

    private List<FunctionCall> ReadToolCalls(JsonElement message, HashSet<string> seenIds)
    {
        if (!message.TryGetProperty("tool_calls", out var calls) || calls.ValueKind == JsonValueKind.Null) return [];
        if (calls.ValueKind != JsonValueKind.Array || calls.GetArrayLength() > MaxToolCalls) throw InvalidResponse();
        var result = new List<FunctionCall>();
        foreach (var call in calls.EnumerateArray())
        {
            if (call.ValueKind != JsonValueKind.Object || !ReadString(call, "id", 128, out var id) || !seenIds.Add(id) ||
                !ReadString(call, "type", 16, out var type) || type != "function" ||
                !call.TryGetProperty("function", out var function) || function.ValueKind != JsonValueKind.Object ||
                !ReadString(function, "name", 64, out var name) || !ReadString(function, "arguments", 2048, out var arguments))
                throw InvalidResponse();
            result.Add(new FunctionCall(id, name, arguments, ReadThoughtSignature(call)));
        }
        return result;
    }

    private string? ReadThoughtSignature(JsonElement call)
    {
        if (provider.Mode != "gemini" ||
            !call.TryGetProperty("extra_content", out var extra) || extra.ValueKind != JsonValueKind.Object ||
            !extra.TryGetProperty("google", out var google) || google.ValueKind != JsonValueKind.Object ||
            !google.TryGetProperty("thought_signature", out var signature)) return null;
        if (signature.ValueKind != JsonValueKind.String || signature.GetString() is not { Length: > 0 and <= 65536 } value)
            throw InvalidResponse();
        return value;
    }

    private static Dictionary<string, object?> SerializeToolCall(FunctionCall call)
    {
        var result = new Dictionary<string, object?>
        {
            ["id"] = call.Id,
            ["type"] = "function",
            ["function"] = new { name = call.Name, arguments = call.Arguments }
        };
        if (call.ThoughtSignature is not null)
            result["extra_content"] = new
            {
                google = new { thought_signature = call.ThoughtSignature }
            };
        return result;
    }

    private static bool ReadString(JsonElement element, string property, int maxLength, out string text)
    {
        text = "";
        if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String) return false;
        text = value.GetString() ?? "";
        return text.Length > 0 && text.Length <= maxLength;
    }

    private static async Task<JsonDocument> ReadResponseAsync(HttpResponseMessage response, CancellationToken token)
    {
        if (response.Content.Headers.ContentLength > MaxResponseBytes) throw InvalidResponse();
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, token);
            if (read == 0) break;
            if (buffer.Length + read > MaxResponseBytes) throw InvalidResponse();
            buffer.Write(chunk, 0, read);
        }
        buffer.Position = 0;
        return await JsonDocument.ParseAsync(buffer, new JsonDocumentOptions { MaxDepth = 32 }, token);
    }

    private async Task<ChatFailure> ProviderFailureAsync(HttpResponseMessage response, CancellationToken token)
    {
        // Provider diagnostics can contain credentials or user text. Only a known status
        // and, for quota errors, an allowlisted code select fixed messages for the client.
        switch ((int)response.StatusCode)
        {
            case 401:
                return new(502, "provider_authentication_failed", $"{provider.DisplayName} rejected the server API key. Update its backend key and restart the API.");
            case 403:
                return new(502, "provider_access_denied", $"{provider.DisplayName} denied this request. Check the API project's permissions and model access.");
            case 404:
                return new(502, "provider_model_unavailable", $"The configured {provider.DisplayName} model is unavailable. Check its backend model setting and project access.");
            case 429:
                if (provider.Mode == "gemini")
                    return new(502, "provider_rate_limited", "Gemini quota or rate limit reached. Wait and check the model's free-tier allowance in Google AI Studio.");
                var quotaExceeded = false;
                try
                {
                    using var document = await ReadResponseAsync(response, token);
                    var root = document.RootElement;
                    quotaExceeded = root.ValueKind == JsonValueKind.Object &&
                        root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object &&
                        error.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String &&
                        code.GetString() is "insufficient_quota" or "billing_hard_limit_reached";
                }
                catch (JsonException) { }
                catch (ChatFailure failure) when (failure.Code == "invalid_provider_response") { }
                return quotaExceeded
                    ? new(502, "provider_quota_exceeded", "OpenAI API quota is exhausted. Check API billing and project limits before retrying.")
                    : new(502, "provider_rate_limited", "OpenAI is rate limiting requests. Wait briefly and try again.");
            case >= 500:
                return new(502, "provider_service_unavailable", $"{provider.DisplayName} returned a server error. Try again shortly.", (int)response.StatusCode);
            default:
                return new(502, "provider_failed", $"{provider.DisplayName} rejected the request. Check its backend model and API project settings, then retry.");
        }
    }

    private static ChatFailure InvalidResponse() =>
        new(502, "invalid_provider_response", "The AI provider returned an unusable response. Please try again later.");

    private static ChatFailure LimitExceeded() =>
        new(502, "agent_limit_exceeded", "The agent reached its tool-use limit. Please try a smaller request.");
}
