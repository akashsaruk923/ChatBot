using System.Net;
using System.Text;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class ProviderConfigurationTests
{
    public static TheoryData<string?, string> InvalidKeys => new()
    {
        { null, "key_missing" },
        { "", "key_missing" },
        { " \r\n\t", "key_missing" },
        { "इथे तुझी API key टाक", "invalid_api_key_configuration" },
        { "इथे तुझी Gemini API key टाक", "invalid_api_key_configuration" },
        { "PASTE_YOUR_GEMINI_KEY_LOCALLY", "invalid_api_key_configuration" },
        { "PASTE_YOUR_KEY_LOCALLY", "invalid_api_key_configuration" },
        { "your_api_key", "invalid_api_key_configuration" },
        { "key with spaces", "invalid_api_key_configuration" },
        { "key\twith-tab", "invalid_api_key_configuration" },
        { "key\r\nwith-newline", "invalid_api_key_configuration" },
        { "key\0with-null", "invalid_api_key_configuration" },
        { "key\u007fwith-del", "invalid_api_key_configuration" },
        { "key\u200bwith-invisible-unicode", "invalid_api_key_configuration" },
        { "non-ASCII-é", "invalid_api_key_configuration" }
    };

    [Theory]
    [MemberData(nameof(InvalidKeys))]
    public async Task InvalidProviderKeyFailsClearlyBeforeAnyRequestForBothProviders(string? key, string expectedCode)
    {
        foreach (var gemini in new[] { true, false })
        {
            var handler = new StubHandler(_ => throw new Exception("An invalid key must not reach HTTP transport."));
            var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler, gemini, key).ReplyAsync([new("user", "Hello")], default));
            Assert.Equal(503, failure.Status);
            Assert.Equal(expectedCode, failure.Code);
            Assert.Null(failure.ProviderStatus);
            Assert.Equal(0, handler.Calls);
            if (!string.IsNullOrEmpty(key)) Assert.DoesNotContain(key, failure.Message);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OuterWhitespaceIsTrimmedAndFutureAsciiKeyFormatsAreNotRejected(bool gemini)
    {
        const string asciiKey = "future-format_unit.test+token=/";
        var handler = new StubHandler(request =>
        {
            Assert.Equal(asciiKey, request.Headers.Authorization!.Parameter);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"Hello.\"}}]}", Encoding.UTF8, "application/json")
            });
        });
        var reply = await Responder(handler, gemini, " \r\n" + asciiKey + "\t ").ReplyAsync([new("user", "Hello")], default);
        Assert.Equal("Hello.", reply);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public void ProviderLabelsCannotExposeArbitraryConfigurationInValidationErrors()
    {
        var failure = Assert.Throws<ChatFailure>(() => ProviderKeyConfiguration.Require("YOUR_API_KEY", "private-provider-metadata"));
        Assert.DoesNotContain("private-provider-metadata", failure.Message);
        Assert.DoesNotContain("YOUR_API_KEY", failure.Message);
        Assert.Equal("invalid_api_key_configuration", failure.Code);
    }

    [Theory]
    [InlineData(HttpRequestError.NameResolutionError, "provider_dns_failed")]
    [InlineData(HttpRequestError.ConnectionError, "provider_connection_failed")]
    [InlineData(HttpRequestError.SecureConnectionError, "provider_tls_failed")]
    [InlineData(HttpRequestError.ProxyTunnelError, "provider_proxy_failed")]
    [InlineData(HttpRequestError.Unknown, "provider_unavailable")]
    [InlineData(HttpRequestError.ResponseEnded, "provider_unavailable")]
    public async Task TransportFailuresAreClassifiedWithoutLeakingDiagnosticsOrRetrying(HttpRequestError error, string expectedCode)
    {
        foreach (var gemini in new[] { true, false })
        {
            var handler = new StubHandler(_ => throw new HttpRequestException(error,
                "private-transport-diagnostic containing actual-unit-test-token and private-user-text"));
            var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler, gemini, "actual-unit-test-token").ReplyAsync([new("user", "Hello")], default));
            Assert.Equal(502, failure.Status);
            Assert.Equal(expectedCode, failure.Code);
            Assert.Null(failure.ProviderStatus);
            Assert.Equal(1, handler.Calls);
            Assert.Contains(gemini ? "Gemini" : "OpenAI", failure.Message);
            Assert.DoesNotContain("private-transport-diagnostic", failure.Message);
            Assert.DoesNotContain("actual-unit-test-token", failure.Message);
            Assert.DoesNotContain("private-user-text", failure.Message);
        }
    }

    [Theory]
    [InlineData(500)]
    [InlineData(503)]
    public async Task ProviderServerErrorsAreDistinctFromTransportFailuresAndExposeOnlyNumericStatus(int status)
    {
        foreach (var gemini in new[] { true, false })
        {
            var handler = new StubHandler(_ => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)
            { Content = new StringContent("private-provider-diagnostic actual-unit-test-token private-user-text") }));
            var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler, gemini, "actual-unit-test-token").ReplyAsync([new("user", "Hello")], default));
            Assert.Equal(502, failure.Status);
            Assert.Equal("provider_service_unavailable", failure.Code);
            Assert.Equal(status, failure.ProviderStatus);
            Assert.Equal(1, handler.Calls);
            Assert.DoesNotContain("private-provider-diagnostic", failure.Message);
            Assert.DoesNotContain("actual-unit-test-token", failure.Message);
            Assert.DoesNotContain("private-user-text", failure.Message);
        }
    }

    private static IChatResponder Responder(HttpMessageHandler handler, bool gemini, string? key)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DadusGemini:ApiKey"] = key,
            ["DadusOpenAI:ApiKey"] = key
        }).Build();
        return gemini ? new GeminiChatResponder(new HttpClient(handler), configuration)
            : new OpenAiChatResponder(new HttpClient(handler), configuration);
    }

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
