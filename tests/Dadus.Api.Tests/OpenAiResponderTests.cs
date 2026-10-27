using System.Net;
using System.Text;
using System.Text.Json;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class OpenAiResponderTests
{
    private static OpenAiChatResponder Responder(HttpMessageHandler handler, string? key = "unit-test-token") =>
        new(new HttpClient(handler), new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["DadusOpenAI:ApiKey"] = key, ["DadusOpenAI:Model"] = "gpt-4o-mini" }).Build());

    [Fact]
    public async Task MissingKeyFailsBeforeAnyNetworkRequest()
    {
        var handler = new StubHandler(_ => throw new Exception("No request should be made."));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler, "").ReplyAsync([], default));
        Assert.Equal(503, failure.Status);
        Assert.Equal("key_missing", failure.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task SendsServerSideAuthorizationAndParsesAssistantReply()
    {
        string? payload = null;
        var handler = new StubHandler(async request =>
        {
            Assert.Equal("https://api.openai.com/v1/chat/completions", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            Assert.Equal("unit-test-token", request.Headers.Authorization.Parameter);
            payload = await request.Content!.ReadAsStringAsync();
            return Json("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\" नमस्कार भावा! \"}}]}");
        });
        var reply = await Responder(handler).ReplyAsync([new("user", "नमस्कार")], default);
        Assert.Equal("नमस्कार भावा!", reply);
        using var json = JsonDocument.Parse(payload!);
        Assert.Equal("gpt-4o-mini", json.RootElement.GetProperty("model").GetString());
        Assert.False(json.RootElement.GetProperty("store").GetBoolean());
        var messages = json.RootElement.GetProperty("messages");
        Assert.Equal("system", messages[0].GetProperty("role").GetString());
        Assert.Equal("नमस्कार", messages[1].GetProperty("content").GetString());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"choices\":[]}")]
    [InlineData("{\"choices\":[null]}")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":null}]}")]
    [InlineData("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"\"}}]}")]
    [InlineData("not json")]
    public async Task InvalidProviderContentReturnsSafe502(string body)
    {
        var handler = new StubHandler(_ => Task.FromResult(Json(body)));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([], default));
        Assert.Equal(502, failure.Status);
        Assert.Equal("invalid_provider_response", failure.Code);
    }

    [Fact]
    public async Task ProviderErrorBodyIsNotExposed()
    {
        var handler = new StubHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)
        { Content = new StringContent("private provider diagnostic") }));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([], default));
        Assert.Equal(502, failure.Status);
        Assert.DoesNotContain("private provider", failure.Message);
    }

    [Fact]
    public async Task UnavailableNetworkReturnsSafe502()
    {
        var handler = new StubHandler(_ => throw new HttpRequestException("transport detail"));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([], default));
        Assert.Equal("provider_unavailable", failure.Code);
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return respond(request);
        }
    }
}
