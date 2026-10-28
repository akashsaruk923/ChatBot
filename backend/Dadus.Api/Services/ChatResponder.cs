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
            _ => "Your conversation is saved, but no AI model was called. Connect Gemini or OpenAI to receive AI responses."
        };
        return Task.FromResult(new AgentReply($"{label}\n{sample}\nTry /calculate (12+3)*2 or /time Asia/Kolkata to use a real local read-only tool in demo mode.", []));
    }
}

public sealed class OpenAiChatResponder(HttpClient httpClient, IConfiguration configuration) : IChatResponder
{
    private readonly CompatibleChatResponder responder = new(httpClient, configuration, ChatProviderProfile.OpenAI);
    public string Mode => responder.Mode;
    public Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        responder.ReplyAsync(context, cancellationToken);
    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        responder.RunAgentAsync(agentId, context, cancellationToken);
}

// Fixed stripes prevent an unbounded dictionary of locks from accumulating arbitrary client IDs.
public sealed class ConversationLocks
{
    private readonly SemaphoreSlim[] locks = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();
    public SemaphoreSlim For(Guid id) => locks[(int)((uint)id.GetHashCode() % (uint)locks.Length)];
}
