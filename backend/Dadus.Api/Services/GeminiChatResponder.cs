namespace Dadus.Api.Services;

public sealed class GeminiChatResponder(HttpClient httpClient, IConfiguration configuration) : IChatResponder
{
    public const string DefaultModel = "gemini-3.8-flash";
    private readonly CompatibleChatResponder responder = new(httpClient, configuration, ChatProviderProfile.Gemini);
    public string Mode => responder.Mode;
    public Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        responder.ReplyAsync(context, cancellationToken);
    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        responder.RunAgentAsync(agentId, context, cancellationToken);
    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, string? language, CancellationToken cancellationToken) =>
        responder.RunAgentAsync(agentId, context, language, cancellationToken);
}
