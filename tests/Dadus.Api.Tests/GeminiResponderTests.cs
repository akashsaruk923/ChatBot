using System.Net;
using System.Text;
using System.Text.Json;
using Dadus.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class GeminiResponderTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task MissingGeminiKeyDoesNotUseTheOpenAiKeyOrMakeARequest(string? key)
    {
        var handler = new SequenceHandler((_, _) => throw new Exception("No request expected."));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler, key).ReplyAsync([], default));
        Assert.Equal("key_missing", failure.Code);
        Assert.Contains("Gemini", failure.Message);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task SendsTheGeminiCompatibilityPayloadAndParsesUnicodeReply()
    {
        var handler = new SequenceHandler(async (request, callNumber) =>
        {
            Assert.Equal("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            Assert.Equal("gemini-unit-test-token", request.Headers.Authorization.Parameter);
            var body = await request.Content!.ReadAsStringAsync();
            Assert.DoesNotContain("gemini-unit-test-token", body);
            using var json = JsonDocument.Parse(body);
            var root = json.RootElement;
            Assert.Equal(GeminiChatResponder.DefaultModel, root.GetProperty("model").GetString());
            Assert.Equal(4096, root.GetProperty("max_tokens").GetInt32());
            Assert.Equal("low", root.GetProperty("reasoning_effort").GetString());
            Assert.Equal("auto", root.GetProperty("tool_choice").GetString());
            Assert.False(root.TryGetProperty("store", out _));
            Assert.False(root.TryGetProperty("parallel_tool_calls", out _));
            Assert.False(root.TryGetProperty("max_completion_tokens", out _));
            Assert.Equal("system", root.GetProperty("messages")[0].GetProperty("role").GetString());
            Assert.Equal("नमस्कार", root.GetProperty("messages")[1].GetProperty("content").GetString());
            var tools = root.GetProperty("tools");
            Assert.Equal(2, tools.GetArrayLength());
            foreach (var tool in tools.EnumerateArray())
            {
                Assert.Equal("function", tool.GetProperty("type").GetString());
                var schema = tool.GetProperty("function").GetProperty("parameters");
                Assert.False(schema.TryGetProperty("additionalProperties", out _));
                foreach (var property in schema.GetProperty("properties").EnumerateObject())
                    Assert.False(property.Value.TryGetProperty("maxLength", out _));
            }
            return Json(FinalReply("नमस्कार भावा!"));
        });
        var responder = Responder(handler);
        Assert.Equal("gemini", responder.Mode);
        Assert.Equal("नमस्कार भावा!", await responder.ReplyAsync([new("user", "नमस्कार")], default));
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task ConfiguredGeminiModelIsUsedWithoutChangingTheEndpoint()
    {
        var handler = new SequenceHandler(async (request, _) =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            Assert.Equal("gemini-3.7-flash", body.RootElement.GetProperty("model").GetString());
            Assert.Equal("generativelanguage.googleapis.com", request.RequestUri!.Host);
            return Json(FinalReply("Hello."));
        });
        await Responder(handler, model: "gemini-3.7-flash").ReplyAsync([new("user", "Hello")], default);
    }

    [Fact]
    public async Task SignedGeminiToolCallsContinueWithOnlyTheOpaqueSignatureAndRealToolResult()
    {
        var handler = new SequenceHandler(async (request, call) =>
        {
            if (call == 1) return Json(SignedToolReply("opaque-test-signature"));
            var payload = await request.Content!.ReadAsStringAsync();
            Assert.DoesNotContain("private-provider-extra", payload);
            Assert.DoesNotContain("private-reasoning-text", payload);
            using var body = JsonDocument.Parse(payload);
            var messages = body.RootElement.GetProperty("messages");
            Assert.Equal("assistant", messages[2].GetProperty("role").GetString());
            Assert.Equal(JsonValueKind.Null, messages[2].GetProperty("content").ValueKind);
            var function = messages[2].GetProperty("tool_calls")[0];
            Assert.Equal("opaque-test-signature", function.GetProperty("extra_content").GetProperty("google").GetProperty("thought_signature").GetString());
            Assert.Single(function.GetProperty("extra_content").EnumerateObject());
            Assert.Single(function.GetProperty("extra_content").GetProperty("google").EnumerateObject());
            Assert.Equal("tool", messages[3].GetProperty("role").GetString());
            Assert.Equal("signed_call", messages[3].GetProperty("tool_call_id").GetString());
            Assert.Contains("30", messages[3].GetProperty("content").GetString());
            return Json(FinalReply("The result is 30."));
        });
        var result = await Responder(handler).RunAgentAsync("planner", [new("user", "Calculate (12+3)*2")], default);
        Assert.Equal("The result is 30.", result.Content);
        Assert.Equal("calculate", Assert.Single(result.Tools).Name);
        Assert.DoesNotContain("opaque-test-signature", result.Content);
        Assert.DoesNotContain("opaque-test-signature", result.Tools[0].Summary);
        Assert.Equal(2, handler.Calls);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public async Task InvalidGeminiSignaturesAreRejectedBeforeContinuation(string? signature)
    {
        var handler = new SequenceHandler((_, _) => Task.FromResult(Json(SignedToolReply(signature))));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).RunAgentAsync("planner", [new("user", "Calculate")], default));
        Assert.Equal("invalid_provider_response", failure.Code);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task OversizedGeminiSignatureIsRejectedBeforeContinuation()
    {
        var handler = new SequenceHandler((_, _) => Task.FromResult(Json(SignedToolReply(new string('s', 65537)))));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).RunAgentAsync("planner", [new("user", "Calculate")], default));
        Assert.Equal("invalid_provider_response", failure.Code);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task GeminiToolLoopUsesTheSameFourRequestBound()
    {
        var handler = new SequenceHandler(async (request, call) =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            Assert.Equal(call == 4 ? "none" : "auto", body.RootElement.GetProperty("tool_choice").GetString());
            return Json(SignedToolReply("opaque-test-signature", "call_" + call));
        });
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).RunAgentAsync("planner", [new("user", "Keep calculating")], default));
        Assert.Equal("agent_limit_exceeded", failure.Code);
        Assert.Equal(4, handler.Calls);
    }

    [Theory]
    [InlineData(401, "provider_authentication_failed")]
    [InlineData(403, "provider_access_denied")]
    [InlineData(404, "provider_model_unavailable")]
    [InlineData(429, "provider_rate_limited")]
    [InlineData(500, "provider_service_unavailable")]
    [InlineData(400, "provider_failed")]
    public async Task GeminiErrorsUseSafeProviderSpecificGuidanceWithoutRetryOrPaidUpgradeAdvice(int status, string code)
    {
        var handler = new SequenceHandler((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)
        { Content = new StringContent("private-provider-extra gemini-unit-test-token upgrade billing") }));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([new("user", "Hello")], default));
        Assert.Equal(502, failure.Status);
        Assert.Equal(code, failure.Code);
        Assert.Equal(status >= 500 ? status : (int?)null, failure.ProviderStatus);
        Assert.Contains("Gemini", failure.Message);
        Assert.DoesNotContain("OpenAI", failure.Message);
        Assert.DoesNotContain("private-provider-extra", failure.Message);
        Assert.DoesNotContain("gemini-unit-test-token", failure.Message);
        Assert.DoesNotContain("billing", failure.Message);
        Assert.Equal(1, handler.Calls);
        if (status == 429) Assert.Contains("free-tier allowance", failure.Message);
    }

    [Fact]
    public async Task TruncatedGeminiRepliesAreNotReturnedAsCompletedAnswers()
    {
        var handler = new SequenceHandler((_, _) => Task.FromResult(Json(FinalReply("Partial private answer", "length"))));
        var failure = await Assert.ThrowsAsync<ChatFailure>(() => Responder(handler).ReplyAsync([new("user", "Hello")], default));
        Assert.Equal("incomplete_provider_response", failure.Code);
        Assert.DoesNotContain("Partial private answer", failure.Message);
    }

    private static GeminiChatResponder Responder(HttpMessageHandler handler, string? key = "gemini-unit-test-token", string? model = null) =>
        new(new HttpClient(handler), new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DadusGemini:ApiKey"] = key,
            ["DadusGemini:Model"] = model,
            ["DadusOpenAI:ApiKey"] = "different-openai-unit-test-token"
        }).Build());

    private static string FinalReply(string content, string finishReason = "stop") => JsonSerializer.Serialize(new
    { choices = new[] { new { finish_reason = finishReason, message = new { role = "assistant", content } } } });

    private static string SignedToolReply(string? signature, string id = "signed_call") => JsonSerializer.Serialize(new
    {
        choices = new[]
        {
            new
            {
                finish_reason = "tool_calls",
                message = new
                {
                    role = "assistant", content = "private-reasoning-text", reasoning_content = "private-reasoning-text",
                    tool_calls = new[]
                    {
                        new
                        {
                            id, type = "function", function = new { name = "calculate", arguments = "{\"expression\":\"(12+3)*2\"}" },
                            extra_content = new { google = new { thought_signature = signature, other = "private-provider-extra" }, other = "private-provider-extra" },
                            other = "private-provider-extra"
                        }
                    }
                }
            }
        }
    });

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed class SequenceHandler(Func<HttpRequestMessage, int, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return respond(request, ++Calls);
        }
    }
}
