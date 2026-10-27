using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class ChatApiTests
{
    [Fact]
    public async Task HealthReportsDatabaseAndHonestDemoMode()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var health = await ReadJson(response);
        Assert.Equal("ok", health.GetProperty("status").GetString());
        Assert.Equal("ready", health.GetProperty("database").GetString());
        Assert.Equal("demo", health.GetProperty("mode").GetString());
    }

    [Fact]
    public async Task ChatPersistsBothMessagesAndListsConversationForItsOwner()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();

        var result = await Send(client, null, " नमस्कार भावा! ");
        Assert.Equal("demo", result.GetProperty("mode").GetString());
        var conversationId = result.GetProperty("conversationId").GetGuid();
        Assert.Equal("assistant", result.GetProperty("message").GetProperty("role").GetString());
        Assert.False(string.IsNullOrWhiteSpace(result.GetProperty("message").GetProperty("content").GetString()));

        var history = await GetJson(client, $"/api/chat/history?conversationId={conversationId}");
        var messages = history.GetProperty("messages").EnumerateArray().ToArray();
        Assert.Equal(2, messages.Length);
        Assert.Equal("user", messages[0].GetProperty("role").GetString());
        Assert.Equal("नमस्कार भावा!", messages[0].GetProperty("content").GetString());
        Assert.Equal("assistant", messages[1].GetProperty("role").GetString());
        Assert.False(history.GetProperty("hasMore").GetBoolean());

        var conversations = await GetJson(client, "/api/chat/conversations");
        var conversation = Assert.Single(conversations.GetProperty("conversations").EnumerateArray());
        Assert.Equal(conversationId, conversation.GetProperty("id").GetGuid());
        Assert.False(string.IsNullOrWhiteSpace(conversation.GetProperty("title").GetString()));
    }

    [Fact]
    public async Task ConversationCannotBeReadOrContinuedByAnotherBrowserSession()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var owner = factory.CreateSessionClient();
        using var stranger = factory.CreateSessionClient();
        var sent = await Send(owner, null, "private local conversation");
        var conversationId = sent.GetProperty("conversationId").GetGuid();

        await AssertProblem(stranger.GetAsync($"/api/chat/history?conversationId={conversationId}"), HttpStatusCode.NotFound);
        await AssertProblem(stranger.PostAsJsonAsync("/api/chat/message", new { conversationId, message = "continue" }), HttpStatusCode.NotFound);
        var list = await GetJson(stranger, "/api/chat/conversations");
        Assert.Empty(list.GetProperty("conversations").EnumerateArray());
        var unchanged = await GetJson(owner, $"/api/chat/history?conversationId={conversationId}");
        Assert.Equal(2, unchanged.GetProperty("messages").GetArrayLength());
    }

    [Fact]
    public async Task HistoryPagesFromNewestAndReturnsEachPageInChronologicalOrder()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        var result = await Send(client, null, "first");
        var conversationId = result.GetProperty("conversationId").GetGuid();
        await Send(client, conversationId, "second");
        await Send(client, conversationId, "third");

        var recent = await GetJson(client, $"/api/chat/history?conversationId={conversationId}&limit=2");
        var recentMessages = recent.GetProperty("messages").EnumerateArray().ToArray();
        Assert.Equal(2, recentMessages.Length);
        Assert.Equal("third", recentMessages[0].GetProperty("content").GetString());
        Assert.True(recent.GetProperty("hasMore").GetBoolean());
        var before = Uri.EscapeDataString(recentMessages[0].GetProperty("createdAt").GetString()!);
        var older = await GetJson(client, $"/api/chat/history?conversationId={conversationId}&before={before}&limit=2");
        var olderMessages = older.GetProperty("messages").EnumerateArray().ToArray();
        Assert.Equal("second", olderMessages[0].GetProperty("content").GetString());
        Assert.True(older.GetProperty("hasMore").GetBoolean());
        Assert.Empty(recentMessages.Select(message => message.GetProperty("id").GetGuid())
            .Intersect(olderMessages.Select(message => message.GetProperty("id").GetGuid())));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task EmptyMessagesHaveStructuredValidationErrors(string message)
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();

        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message }), HttpStatusCode.BadRequest);
        var conversations = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(conversations.GetProperty("conversations").EnumerateArray());
    }

    [Fact]
    public async Task OversizedMessageIsRejectedBeforePersistence()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();

        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message = new string('x', 4001) }), HttpStatusCode.BadRequest);
        var conversations = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(conversations.GetProperty("conversations").EnumerateArray());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not-a-guid")]
    public async Task MissingOrInvalidSessionIsRejected(string? header)
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateClient();
        if (header is not null) client.DefaultRequestHeaders.Add("X-Dadus-Session", header);

        await AssertProblem(client.GetAsync("/api/chat/conversations"), HttpStatusCode.BadRequest);
        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message = "hello" }), HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData("limit=0")]
    [InlineData("limit=101")]
    [InlineData("before=not-a-date")]
    public async Task InvalidPaginationIsRejected(string query)
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        var result = await Send(client, null, "hello");
        var conversationId = result.GetProperty("conversationId").GetGuid();

        await AssertProblem(client.GetAsync($"/api/chat/history?conversationId={conversationId}&{query}"), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ProviderFailureDoesNotCreateConversationOrOrphanedUserMessage()
    {
        using var factory = new DadusFactory(new FailingResponder());
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();

        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message = "hello" }), HttpStatusCode.BadGateway);
        var conversations = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(conversations.GetProperty("conversations").EnumerateArray());
    }

    [Fact]
    public async Task LiveModeWithNoKeyReportsSetupErrorAndDoesNotPersist()
    {
        using var factory = new DadusFactory(mode: "OpenAI");
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        await AssertProblem(client.GetAsync("/api/health"), HttpStatusCode.ServiceUnavailable);
        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message = "hello" }), HttpStatusCode.ServiceUnavailable);
        var list = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(list.GetProperty("conversations").EnumerateArray());
    }

    [Fact]
    public async Task DemoModeIsNotAvailableInProduction()
    {
        using var factory = new DadusFactory(mode: "Demo", environment: "Production");
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        await AssertProblem(client.GetAsync("/api/health"), HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task AgentCatalogExposesTheThreeRolesAndOnlySupportedTools()
    {
        using var factory = new DadusFactory();
        using var client = factory.CreateClient();
        var catalog = await GetJson(client, "/api/agents");
        var agents = catalog.GetProperty("agents").EnumerateArray().ToArray();
        Assert.Equal(new[] { "coding", "companion", "planner" }, agents.Select(agent => agent.GetProperty("id").GetString()).Order());
        Assert.All(agents, agent =>
        {
            Assert.False(string.IsNullOrWhiteSpace(agent.GetProperty("description").GetString()));
            Assert.All(agent.GetProperty("tools").EnumerateArray(), tool =>
                Assert.Contains(tool.GetString(), new[] { "calculate", "get_current_time" }));
        });
    }

    [Fact]
    public async Task UnrecognizedAgentDoesNotPersistAnExchange()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        await AssertProblem(client.PostAsJsonAsync("/api/chat/message", new { message = "hello", agentId = "unknown" }), HttpStatusCode.BadRequest);
        var list = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(list.GetProperty("conversations").EnumerateArray());
    }

    [Fact]
    public async Task DemoAgentCanCalculateAndContinueAnExistingConversation()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        var start = await Send(client, null, "hello");
        Assert.Equal("companion", start.GetProperty("agentId").GetString());
        var conversationId = start.GetProperty("conversationId").GetGuid();
        using var response = await client.PostAsJsonAsync("/api/chat/message",
            new { conversationId, message = "/calculate (12+3)*2", agentId = "planner" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await ReadJson(response);
        Assert.Equal("planner", result.GetProperty("agentId").GetString());
        Assert.Equal("demo", result.GetProperty("mode").GetString());
        Assert.Contains("30", result.GetProperty("message").GetProperty("content").GetString());
        var tool = Assert.Single(result.GetProperty("tools").EnumerateArray());
        Assert.Equal("calculate", tool.GetProperty("name").GetString());
        Assert.False(string.IsNullOrWhiteSpace(tool.GetProperty("summary").GetString()));
        var history = await GetJson(client, $"/api/chat/history?conversationId={conversationId}");
        Assert.Equal(4, history.GetProperty("messages").GetArrayLength());
    }

    [Theory]
    [InlineData("🙂")]
    [InlineData("e\u0301")]
    public async Task ConversationTitleDoesNotSplitAUnicodeTextElement(string suffix)
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        var prefix = new string('a', 79);
        await Send(client, null, prefix + suffix);
        var list = await GetJson(client, "/api/chat/conversations");
        var conversation = Assert.Single(list.GetProperty("conversations").EnumerateArray());
        Assert.Equal(prefix, conversation.GetProperty("title").GetString());
    }

    [Fact]
    public async Task OversizedFirstTextElementStillGetsAReadableBoundedTitle()
    {
        using var factory = new DadusFactory();
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        await Send(client, null, "a" + new string('\u0301', 100));
        var list = await GetJson(client, "/api/chat/conversations");
        var conversation = Assert.Single(list.GetProperty("conversations").EnumerateArray());
        Assert.Equal("New conversation", conversation.GetProperty("title").GetString());
    }

    [Theory]
    [InlineData("length")]
    [InlineData("content_filter")]
    public async Task IncompleteModelCompletionIsRejectedBeforeSavingAnExchange(string finishReason)
    {
        using var transport = new HttpClient(new IncompleteCompletionHandler(finishReason));
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["DadusOpenAI:ApiKey"] = "unit-test-token" }).Build();
        using var factory = new DadusFactory(new OpenAiChatResponder(transport, configuration));
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();
        using var response = await client.PostAsJsonAsync("/api/chat/message", new { message = "Explain a C# method", agentId = "coding" });
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var error = await ReadJson(response);
        Assert.Equal("incomplete_provider_response", error.GetProperty("code").GetString());
        var list = await GetJson(client, "/api/chat/conversations");
        Assert.Empty(list.GetProperty("conversations").EnumerateArray());
    }

    private sealed class IncompleteCompletionHandler(string finishReason) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new
                {
                    choices = new[] { new { finish_reason = finishReason, message = new { content = "Here is the unfinished method {" } } }
                })
            });
    }

    private sealed class FailingResponder : IChatResponder
    {
        public string Mode => "openai";
        public Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
            throw new ChatFailure(502, "provider_failed", "The model provider is temporarily unavailable.");
    }

    private static async Task<JsonElement> Send(HttpClient client, Guid? conversationId, string message)
    {
        using var response = await client.PostAsJsonAsync("/api/chat/message", new { conversationId, message });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJson(response);
    }

    private static async Task<JsonElement> GetJson(HttpClient client, string uri)
    {
        using var response = await client.GetAsync(uri);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJson(response);
    }

    private static async Task<JsonElement> ReadJson(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).Clone();

    private static async Task AssertProblem(Task<HttpResponseMessage> request, HttpStatusCode expectedStatus)
    {
        using var response = await request;
        Assert.Equal(expectedStatus, response.StatusCode);
        var problem = await ReadJson(response);
        Assert.Equal((int)expectedStatus, problem.GetProperty("status").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("code").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("title").GetString()));
    }
}
