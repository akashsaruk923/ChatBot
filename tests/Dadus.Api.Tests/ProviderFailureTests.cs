using System.Net;
using System.Text;
using System.Text.Json;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class ProviderFailureTests
{
    [Theory]
    [InlineData(401, "insufficient_quota", "provider_authentication_failed")]
    [InlineData(403, "insufficient_quota", "provider_access_denied")]
    [InlineData(404, "model_not_found", "provider_model_unavailable")]
    [InlineData(429, "insufficient_quota", "provider_quota_exceeded")]
    [InlineData(429, "billing_hard_limit_reached", "provider_quota_exceeded")]
    [InlineData(429, "rate_limit_exceeded", "provider_rate_limited")]
    [InlineData(429, "private-provider-diagnostic-unit-test-token", "provider_rate_limited")]
    [InlineData(500, "insufficient_quota", "provider_service_unavailable")]
    [InlineData(503, "server_error", "provider_service_unavailable")]
    [InlineData(400, "invalid_request_error", "provider_failed")]
    public async Task ProviderFailuresReturnSpecificSafeRecoveryCodesWithoutRetrying(int status, string providerCode, string expectedCode)
    {
        var body = JsonSerializer.Serialize(new
        {
            error = new
            {
                code = providerCode,
                message = "private-provider-diagnostic: rejected unit-test-token; user said private-user-text",
                type = "private-provider-diagnostic"
            }
        });
        var handler = new FailureHandler(status, body);

        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([new("user", "Hello")], default));

        Assert.Equal(502, failure.Status);
        Assert.Equal(expectedCode, failure.Code);
        Assert.Equal(status >= 500 ? status : (int?)null, failure.ProviderStatus);
        Assert.Equal(1, handler.Calls);
        Assert.DoesNotContain("private-provider-diagnostic", failure.Message);
        Assert.DoesNotContain("unit-test-token", failure.Message);
        Assert.DoesNotContain("private-user-text", failure.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json private-provider-diagnostic")]
    [InlineData("[]")]
    [InlineData("{\"error\":null}")]
    [InlineData("{\"error\":{\"code\":123}}")]
    [InlineData("{\"error\":{\"code\":null,\"message\":\"insufficient_quota\"}}")]
    [InlineData("{\"error\":{\"code\":\"unknown\",\"message\":\"insufficient_quota\"}}")]
    public async Task Unrecognized429BodiesRemainRateLimitedWithoutExposingOrGuessingFromMessage(string body)
    {
        var handler = new FailureHandler(429, body);

        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([], default));

        Assert.Equal("provider_rate_limited", failure.Code);
        Assert.Equal("OpenAI is rate limiting requests. Wait briefly and try again.", failure.Message);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task OversizedQuotaDiagnosticsAreNotParsedAndDoNotReplaceTheKnownHttpFailure()
    {
        var body = JsonSerializer.Serialize(new
        {
            error = new { code = "insufficient_quota", message = new string('x', 128 * 1024) }
        });
        var handler = new FailureHandler(429, body);

        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([], default));

        Assert.Equal("provider_rate_limited", failure.Code);
        Assert.Equal(1, handler.Calls);
    }

    private static OpenAiChatResponder Responder(HttpMessageHandler handler) => new(new HttpClient(handler),
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["DadusOpenAI:ApiKey"] = "unit-test-token" }).Build());

    private sealed class FailureHandler(int status, string body) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)
            { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }
}
