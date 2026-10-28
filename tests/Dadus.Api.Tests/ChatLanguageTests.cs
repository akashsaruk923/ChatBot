using System.Net;
using System.Text;
using System.Text.Json;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class ChatLanguageTests
{
    [Theory]
    [InlineData(null, "auto")]
    [InlineData("", "auto")]
    [InlineData("  ", "auto")]
    [InlineData("MR", "mr")]
    [InlineData(" hi ", "hi")]
    [InlineData("en", "en")]
    [InlineData("AUTO", "auto")]
    public void NormalizesSupportedLanguageChoices(string? supplied, string expected) =>
        Assert.Equal(expected, ChatLanguage.Normalize(supplied));

    [Theory]
    [InlineData("en", "Current reply language: English.")]
    [InlineData("hi", "Current reply language: Hindi (हिन्दी).")]
    [InlineData("mr", "Current reply language: Marathi (मराठी).")]
    public async Task BothProvidersReceiveExplicitLanguagePolicyWithoutLosingConversationContext(string language, string expectedPolicy)
    {
        foreach (var gemini in new[] { false, true })
        {
            var history = new ChatTurn[]
            {
                new("user", "I am learning something new."),
                new("assistant", "We were speaking in English."),
                new("user", "आता पुढे सांग")
            };
            var handler = new InspectHandler(async request =>
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
                var messages = body.RootElement.GetProperty("messages");
                Assert.Equal(4, messages.GetArrayLength());
                var system = messages[0].GetProperty("content").GetString()!;
                Assert.Contains(expectedPolicy, system);
                Assert.Contains("This selection applies to this reply even when earlier messages", system);
                Assert.Contains("without forcing slang or pet names", system);
                Assert.Contains("one relevant follow-up when it helps", system);
                Assert.Contains("Avoid repetitive greetings", system);
                if (language is "mr" or "hi") Assert.Contains("using Devanagari", system);
                for (var index = 0; index < history.Length; index++)
                {
                    Assert.Equal(history[index].Role, messages[index + 1].GetProperty("role").GetString());
                    Assert.Equal(history[index].Content, messages[index + 1].GetProperty("content").GetString());
                }
                return Reply("पूर्ण उत्तर");
            });

            var result = await Responder(handler, gemini).RunAgentAsync("companion", history, language, default);

            Assert.Equal("पूर्ण उत्तर", result.Content);
            Assert.Equal(1, handler.Calls);
        }
    }

    [Theory]
    [InlineData("mala madat kar")]
    [InlineData("mujhe madad chahiye")]
    public async Task AutoLanguageRecognizesRomanMarathiAndHindiAsPossibleUserLanguages(string message)
    {
        foreach (var gemini in new[] { false, true })
        {
            var handler = new InspectHandler(async request =>
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
                var messages = body.RootElement.GetProperty("messages");
                var system = messages[0].GetProperty("content").GetString()!;
                Assert.Contains("Current reply language: Auto.", system);
                Assert.Contains("latest user message", system);
                Assert.Contains("Roman letters alone do not mean English", system);
                Assert.Contains("Marathi and Hindi written with Roman letters", system);
                Assert.Equal(message, messages[1].GetProperty("content").GetString());
                return Reply("नक्की, सांग.");
            });

            var result = await Responder(handler, gemini).RunAgentAsync("companion", [new("user", message)], "auto", default);
            Assert.Equal("नक्की, सांग.", result.Content);
        }
    }

    [Theory]
    [InlineData("planner", "planning agent")]
    [InlineData("coding", "coding mentor")]
    public async Task SpecializedAgentsKeepTheirRoleAndApplyTheSelectedLanguage(string agentId, string expectedRole)
    {
        var handler = new InspectHandler(async request =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var system = body.RootElement.GetProperty("messages")[0].GetProperty("content").GetString()!;
            Assert.Contains(expectedRole, system);
            Assert.Contains("Current reply language: Hindi (हिन्दी).", system);
            return Reply("ज़रूर, शुरू करते हैं।");
        });
        var result = await Responder(handler, true).RunAgentAsync(agentId, [new("user", "Help me")], "hi", default);
        Assert.Equal("ज़रूर, शुरू करते हैं।", result.Content);
    }

    [Theory]
    [InlineData("fr")]
    [InlineData("mr-IN")]
    [InlineData("Marathi")]
    [InlineData("mr; private-injected-instruction")]
    public async Task UnsupportedLanguageCannotReachProviderOrBecomeAnInstruction(string supplied)
    {
        foreach (var gemini in new[] { false, true })
        {
            var handler = new InspectHandler(_ => throw new Exception("Invalid language must not send a provider request."));
            var failure = await Assert.ThrowsAsync<ChatFailure>(() =>
                Responder(handler, gemini).RunAgentAsync("companion", [new("user", "Hello")], supplied, default));
            Assert.Equal(400, failure.Status);
            Assert.Equal("invalid_language", failure.Code);
            Assert.DoesNotContain("private-injected-instruction", failure.Message);
            Assert.Equal(0, handler.Calls);
        }
        var demoFailure = await Assert.ThrowsAsync<ChatFailure>(() =>
            new DemoChatResponder().RunAgentAsync("companion", [new("user", "Hello")], supplied, default));
        Assert.Equal("invalid_language", demoFailure.Code);
    }

    [Theory]
    [InlineData("en", "No AI model was called", "Your conversation is saved")]
    [InlineData("hi", "किसी AI मॉडल को अनुरोध नहीं भेजा गया है", "यह चैट की जांच के लिए एक तय नमूना है")]
    [InlineData("mr", "कोणत्याही AI मॉडेलला विनंती पाठवलेली नाही", "हा चॅटची चाचणी करण्यासाठी ठराविक नमुना आहे")]
    public async Task DemoRepliesAreLocalizedAndStillClearlyDiscloseNoModelCall(string language, string disclosure, string sample)
    {
        var result = await new DemoChatResponder().RunAgentAsync("companion", [new("user", "Hello")], language, default);
        Assert.Contains(disclosure, result.Content);
        Assert.Contains(sample, result.Content);
        Assert.Empty(result.Tools);
    }

    [Theory]
    [InlineData("en")]
    [InlineData("hi")]
    [InlineData("mr")]
    public async Task LocalizedDemoStillExecutesRealReadOnlyTools(string language)
    {
        var result = await new DemoChatResponder().RunAgentAsync("planner", [new("user", "/calculate 2+3")], language, default);
        Assert.Equal("calculate", Assert.Single(result.Tools).Name);
        Assert.Contains("2+3 = 5", result.Content);
    }

    [Fact]
    public async Task ExistingReplyOnlyRespondersRemainCompatibleWithTheLanguageAwareInterface()
    {
        IChatResponder legacy = new LegacyResponder();
        var result = await legacy.RunAgentAsync("companion", [new("user", "नमस्कार")], "mr", default);
        Assert.Equal("Legacy responder reply", result.Content);
        Assert.Empty(result.Tools);
    }

    private static IChatResponder Responder(HttpMessageHandler handler, bool gemini)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DadusGemini:ApiKey"] = "language-unit-test-key",
            ["DadusOpenAI:ApiKey"] = "language-unit-test-key"
        }).Build();
        return gemini ? new GeminiChatResponder(new HttpClient(handler), configuration)
            : new OpenAiChatResponder(new HttpClient(handler), configuration);
    }

    private static HttpResponseMessage Reply(string content) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(new
        {
            choices = new[] { new { finish_reason = "stop", message = new { content } } }
        }), Encoding.UTF8, "application/json")
    };

    private sealed class LegacyResponder : IChatResponder
    {
        public string Mode => "demo";
        public Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
            Task.FromResult("Legacy responder reply");
    }

    private sealed class InspectHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return respond(request);
        }
    }
}
