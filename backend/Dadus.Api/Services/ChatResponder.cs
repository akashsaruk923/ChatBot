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

    Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, string? language, CancellationToken cancellationToken)
    {
        _ = ChatLanguage.Normalize(language);
        return RunAgentAsync(agentId, context, cancellationToken);
    }
}

public sealed class ChatFailure(int status, string code, string safeMessage, int? providerStatus = null) : Exception(safeMessage)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public int? ProviderStatus { get; } = providerStatus;
}

public sealed class DemoChatResponder : IChatResponder
{
    public string Mode => "demo";

    public async Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        (await RunAgentAsync("companion", context, cancellationToken)).Content;

    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
        RunAgentAsync(agentId, context, "auto", cancellationToken);

    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, string? language, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var replyLanguage = ChatLanguage.Normalize(language);
        var agent = AgentCatalog.Get(agentId);
        var text = context.LastOrDefault(turn => turn.Role == "user")?.Content.Trim() ?? "";
        ToolExecution? execution = null;
        if (text.Equals("/calculate", StringComparison.OrdinalIgnoreCase) || text.StartsWith("/calculate ", StringComparison.OrdinalIgnoreCase))
            execution = AgentTools.Execute("calculate", JsonSerializer.SerializeToElement(new { expression = text[10..].Trim() }), cancellationToken);
        else if (text.Equals("/time", StringComparison.OrdinalIgnoreCase) || text.StartsWith("/time ", StringComparison.OrdinalIgnoreCase))
            execution = AgentTools.Execute("get_current_time", JsonSerializer.SerializeToElement(new { timezone = text[5..].Trim() is { Length: > 0 } timezone ? timezone : "Asia/Kolkata" }), cancellationToken);

        var label = replyLanguage switch
        {
            "mr" => $"नमस्कार! डेमो — {agent.Name}. कोणत्याही AI मॉडेलला विनंती पाठवलेली नाही.",
            "hi" => $"नमस्ते! डेमो — {agent.Name}. किसी AI मॉडल को अनुरोध नहीं भेजा गया है।",
            "en" => $"Hello! Offline demo — {agent.Name}. No AI model was called.",
            _ => $"बोल भावा! काय म्हणतोस? Offline demo — {agent.Name}. No AI model was called."
        };
        if (execution is not null)
            return Task.FromResult(new AgentReply($"{label}\n{execution.Summary}", [execution]));
        var sample = (replyLanguage, agentId) switch
        {
            ("mr", "planner") => "नियोजनाचा ठराविक नमुना: उद्दिष्ट ठरवा, लहान पायऱ्या आखा आणि पुढचं पाऊल निवडा. हा AI ने तयार केलेला आराखडा नाही.",
            ("mr", "coding") => "कोड समजावण्याचा ठराविक नमुना: अपेक्षित बदल स्पष्ट करा, संबंधित कोड पाहा आणि तपासता येईल असा उपाय सुचवा. कोणताही कोड चालवलेला नाही.",
            ("mr", _) => "हा चॅटची चाचणी करण्यासाठी ठराविक नमुना आहे. तुमचा संवाद जतन होतो. खऱ्या AI उत्तरांसाठी Gemini किंवा OpenAI जोडा.",
            ("hi", "planner") => "योजना का तय नमूना: लक्ष्य तय करें, छोटे चरण बनाएं और अगला कदम चुनें। यह AI से तैयार की गई योजना नहीं है।",
            ("hi", "coding") => "कोड समझाने का तय नमूना: ज़रूरी बदलाव बताएं, संबंधित कोड देखें और जांचने योग्य सुझाव दें। कोई कोड चलाया नहीं गया है।",
            ("hi", _) => "यह चैट की जांच के लिए एक तय नमूना है। आपका संवाद सहेजा जाता है। असली AI उत्तरों के लिए Gemini या OpenAI जोड़ें।",
            (_, "planner") => "Sample planning workflow: define the goal, split it into small steps, identify dependencies, then review the next action. This is a fixed demo example, not an AI-generated plan.",
            (_, "coding") => "Sample coding workflow: describe the .NET feature, inspect the relevant code, propose a small change and verify it with a meaningful test. This is a fixed demo example; no code was executed.",
            _ => "Your conversation is saved, but no AI model was called. Connect Gemini or OpenAI to receive AI responses."
        };
        var toolsHelp = replyLanguage switch
        {
            "mr" => "या डेमोमध्ये प्रत्यक्ष स्थानिक साधन वापरण्यासाठी /calculate (12+3)*2 किंवा /time Asia/Kolkata पाठवा.",
            "hi" => "इस डेमो में असली स्थानीय टूल के लिए /calculate (12+3)*2 या /time Asia/Kolkata भेजें।",
            _ => "Try /calculate (12+3)*2 or /time Asia/Kolkata to use a real local read-only tool in demo mode."
        };
        return Task.FromResult(new AgentReply($"{label}\n{sample}\n{toolsHelp}", []));
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
    public Task<AgentReply> RunAgentAsync(string agentId, IReadOnlyList<ChatTurn> context, string? language, CancellationToken cancellationToken) =>
        responder.RunAgentAsync(agentId, context, language, cancellationToken);
}

// Fixed stripes prevent an unbounded dictionary of locks from accumulating arbitrary client IDs.
public sealed class ConversationLocks
{
    private readonly SemaphoreSlim[] locks = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();
    public SemaphoreSlim For(Guid id) => locks[(int)((uint)id.GetHashCode() % (uint)locks.Length)];
}
