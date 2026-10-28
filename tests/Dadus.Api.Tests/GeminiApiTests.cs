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

public sealed class GeminiApiTests
{
    [Fact]
    public async Task GeminiModeUsesItsOwnKeyReportsItsIdentityAndPersistsACompletedExchange()
    {
        using var root = new DadusFactory(mode: "Gemini");
        var transport = new GeminiTransport();
        using var factory = root.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?> { ["DadusGemini:ApiKey"] = "unit-test-gemini-token" }));
            builder.ConfigureServices(services => services.AddHttpClient<GeminiChatResponder>()
                .ConfigurePrimaryHttpMessageHandler(() => transport));
        });
        await using (var scope = factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<DadusDbContext>().Database.EnsureCreatedAsync();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Dadus-Session", Guid.NewGuid().ToString());

        using var health = await client.GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        var healthBody = await health.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("gemini", healthBody.GetProperty("mode").GetString());
        Assert.Equal(0, transport.Calls);

        using var response = await client.PostAsJsonAsync("/api/chat/message", new { message = "नमस्कार", agentId = "companion" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var reply = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("gemini", reply.GetProperty("mode").GetString());
        Assert.Equal("नमस्कार!", reply.GetProperty("message").GetProperty("content").GetString());
        Assert.Equal(1, transport.Calls);

        using var history = await client.GetAsync($"/api/chat/history?conversationId={reply.GetProperty("conversationId").GetGuid()}");
        Assert.Equal(HttpStatusCode.OK, history.StatusCode);
        var historyBody = await history.Content.ReadFromJsonAsync<JsonElement>();
        var messages = historyBody.GetProperty("messages").EnumerateArray().ToArray();
        Assert.Equal(2, messages.Length);
        Assert.Equal("नमस्कार", messages[0].GetProperty("content").GetString());
        Assert.Equal("नमस्कार!", messages[1].GetProperty("content").GetString());
        Assert.DoesNotContain("unit-test-gemini-token", historyBody.ToString());
    }

    private sealed class GeminiTransport : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            Assert.Equal("unit-test-gemini-token", request.Headers.Authorization.Parameter);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new
                {
                    choices = new[] { new { finish_reason = "stop", message = new { content = "नमस्कार!" } } }
                })
            });
        }
    }
}
