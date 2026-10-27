using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Dadus.Api.Services;

public record ChatTurn(string Role, string Content);

public interface IChatResponder
{
    string Mode { get; }
    Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken);

    // Keeps existing responders/test doubles compatible while exposing agent metadata.
    async Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        new(await ReplyAsync(context, cancellationToken), []);
}

public sealed class ChatFailure(int status, string code, string safeMessage) : Exception(safeMessage)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public sealed class DemoChatResponder : IChatResponder
{
    public string Mode => "demo";

    public async Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        (await RunAgentAsync("companion", context, cancellationToken)).Content;

    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var agent = AgentCatalog.Get(agentId);
        var text = context.LastOrDefault(turn => turn.Role == "user")?.Content.Trim() ?? "";
        ToolExecution? execution = null;
        if (text.Equals("/calculate", StringComparison.OrdinalIgnoreCase) || text.StartsWith("/calculate ", StringComparison.OrdinalIgnoreCase))
            execution = AgentTools.Execute("calculate", JsonSerializer.SerializeToElement(new { expression = text[10..].Trim() }), cancellationToken);
        else if (text.Equals("/time", StringComparison.OrdinalIgnoreCase) || text.StartsWith("/time ", StringComparison.OrdinalIgnoreCase))
            execution = AgentTools.Execute("get_current_time", JsonSerializer.SerializeToElement(new { timezone = text[5..].Trim() is { Length: > 0 } timezone ? timezone : "Asia/Kolkata" }), cancellationToken);

        var label = $"बोल भावा! काय म्हणतोस? Offline demo — {agent.Name}. No AI model was called.";
        if (execution is not null)
            return Task.FromResult(new AgentReply($"{label}\n{execution.Summary}", [execution]));
        var sample = agentId switch
        {
            "planner" => "Sample planning workflow: define the goal, split it into small steps, identify dependencies, then review the next action. This is a fixed demo example, not an AI-generated plan.",
            "coding" => "Sample coding workflow: describe the .NET feature, inspect the relevant code, propose a small change and verify it with a meaningful test. This is a fixed demo example; no code was executed.",
            _ => "Your conversation is saved, but no AI model was called. Connect OpenAI to receive AI responses."
        };
        return Task.FromResult(new AgentReply($"{label}\n{sample}\nTry /calculate (12+3)*2 or /time Asia/Kolkata to use a real local read-only tool in demo mode.", []));
    }
}

public sealed class OpenAiChatResponder(HttpClient httpClient, IConfiguration configuration) : IChatResponder
{
    private const int MaxRounds = 4;
    private const int MaxToolCalls = 4;
    private const int MaxResponseBytes = 128 * 1024;
    public string Mode => "openai";

    public async Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        (await RunAgentAsync("companion", context, cancellationToken)).Content;

    public async Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = AgentCatalog.Get(agentId);
        var key = configuration["DadusOpenAI:ApiKey"];
        if (string.IsNullOrWhiteSpace(key))
            throw new ChatFailure(503, "key_missing", "OpenAI access is not configured. Ask the developer to configure the server API key.");
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
                using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/chat/completions");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                request.Content = JsonContent.Create(new
                {
                    model = configuration["DadusOpenAI:Model"] ?? "gpt-4o-mini",
                    messages,
                    tools = AgentTools.Definitions,
                    tool_choice = round == MaxRounds - 1 || executions.Count >= MaxToolCalls ? "none" : "auto",
                    parallel_tool_calls = false,
                    max_completion_tokens = 1024,
                    store = false
                });
                using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if (!response.IsSuccessStatusCode)
                    throw new ChatFailure(502, "provider_failed", "The AI provider could not complete the request. Please try again later.");
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

                // Reconstruct only protocol fields; never forward provider extras or hidden reasoning.
                messages.Add(new
                {
                    role = "assistant",
                    content = (string?)null,
                    tool_calls = calls.Select(call => new
                    {
                        id = call.Id, type = "function", function = new { name = call.Name, arguments = call.Arguments }
                    }).ToArray()
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
            throw new ChatFailure(504, "provider_timeout", "The AI provider took too long to respond. Please try again.");
        }
        catch (HttpRequestException)
        {
            throw new ChatFailure(502, "provider_unavailable", "The AI provider is unavailable. Please try again later.");
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

    private sealed record FunctionCall(string Id, string Name, string Arguments);

    private static List<FunctionCall> ReadToolCalls(JsonElement message, HashSet<string> seenIds)
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
            result.Add(new FunctionCall(id, name, arguments));
        }
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

    private static ChatFailure InvalidResponse() =>
        new(502, "invalid_provider_response", "The AI provider returned an unusable response. Please try again later.");

    private static ChatFailure LimitExceeded() =>
        new(502, "agent_limit_exceeded", "The agent reached its tool-use limit. Please try a smaller request.");
}

// Fixed stripes prevent an unbounded dictionary of locks from accumulating arbitrary client IDs.
public sealed class ConversationLocks
{
    private readonly SemaphoreSlim[] locks = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();
    public SemaphoreSlim For(Guid id) => locks[(int)((uint)id.GetHashCode() % (uint)locks.Length)];
}
