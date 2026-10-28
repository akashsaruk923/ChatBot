using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dadus.Api.Data;
using Dadus.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class ProviderReadinessTests
{
    [Theory]
    [InlineData("इथे खरी Gemini key टाक")]
    [InlineData("PASTE_YOUR_GEMINI_KEY_LOCALLY")]
    [InlineData("key with internal spaces")]
    public async Task InvalidKeyConfigurationFailsHealthAndChatWithoutCallingProviderOrSavingMessages(string invalidKey)
    {
        using var root = new DadusFactory(mode: "Gemini");
        var transport = new NeverCalledTransport();
        using var factory = root.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?> { ["DadusGemini:ApiKey"] = invalidKey }));
            builder.ConfigureServices(services => services.AddHttpClient<GeminiChatResponder>()
                .ConfigurePrimaryHttpMessageHandler(() => transport));
        });
        await using (var scope = factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<DadusDbContext>().Database.EnsureCreatedAsync();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Dadus-Session", Guid.NewGuid().ToString());

        using var health = await client.GetAsync("/api/health");
        using var chat = await client.PostAsJsonAsync("/api/chat/message", new { message = "नमस्कार" });
        foreach (var response in new[] { health, chat })
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("invalid_api_key_configuration", body.GetProperty("code").GetString());
            Assert.DoesNotContain(invalidKey, body.ToString());
        }
        Assert.Equal(0, transport.Calls);
        var conversations = await client.GetFromJsonAsync<JsonElement>("/api/chat/conversations");
        Assert.Empty(conversations.GetProperty("conversations").EnumerateArray());
    }

    [Theory]
    [InlineData(500)]
    [InlineData(503)]
    [InlineData(599)]
    [InlineData(400)]
    [InlineData(null)]
    public async Task ProblemsExposeOnlyValidatedUpstreamServerStatus(int? upstreamStatus)
    {
        using var factory = new DadusFactory(new UnavailableResponder(upstreamStatus));
        await factory.InitializeDatabaseAsync();
        using var client = factory.CreateSessionClient();

        using var response = await client.PostAsJsonAsync("/api/chat/message", new { message = "Hello" });
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("provider_service_unavailable", body.GetProperty("code").GetString());
        if (upstreamStatus is >= 500 and <= 599)
            Assert.Equal(upstreamStatus, body.GetProperty("providerStatus").GetInt32());
        else
            Assert.False(body.TryGetProperty("providerStatus", out _));
    }

    private sealed class UnavailableResponder(int? upstreamStatus) : IChatResponder
    {
        public string Mode => "gemini";
        public Task<string> ReplyAsync(IReadOnlyList<ChatTurn> context, CancellationToken cancellationToken) =>
            throw new ChatFailure(502, "provider_service_unavailable", "The AI service returned a server error.", upstreamStatus);
    }

    private sealed class NeverCalledTransport : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            throw new InvalidOperationException("A malformed configured key must never be sent.");
        }
    }
}
