using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Dadus.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class SpeechApiTests
{
    [Fact]
    public async Task MissingOptionalAzureSettingsDoNotBreakChatReadinessOrExposeAKey()
    {
        using var root = new DadusFactory();
        using var factory = Configure(root, new InspectHandler(_ => throw new Exception("No provider call expected.")),
            new() { ["DadusAzureSpeech:ApiKey"] = "", ["DadusAzureSpeech:Region"] = "" });
        await InitializeAsync(factory);
        using var client = SessionClient(factory);

        using var health = await client.GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        var result = await health.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("ready", result.GetProperty("database").GetString());
        Assert.Equal("demo", result.GetProperty("mode").GetString());
        Assert.Equal("azure", result.GetProperty("speech").GetProperty("provider").GetString());
        Assert.False(result.GetProperty("speech").GetProperty("configured").GetBoolean());

        using var config = await client.GetAsync("/api/speech/config");
        var metadata = await config.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1000, metadata.GetProperty("maxTextLength").GetInt32());
        Assert.Equal(new[] { "mr-IN", "hi-IN", "en-IN" },
            metadata.GetProperty("languages").EnumerateArray().Select(value => value.GetString()));

        using var speech = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "नमस्कार", language = "mr-IN" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, speech.StatusCode);
        await AssertCodeAsync(speech, "speech_not_configured");
    }

    [Fact]
    public async Task BrowserSpeechRemainsTheDefaultWithoutAnAzureDependency()
    {
        using var root = new DadusFactory();
        using var factory = Configure(root, new InspectHandler(_ => throw new Exception("No provider call expected.")),
            new() { ["Speech:Provider"] = "Browser" });
        using var client = SessionClient(factory);
        using var config = await client.GetAsync("/api/speech/config");
        Assert.Equal(HttpStatusCode.OK, config.StatusCode);
        var metadata = await config.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("browser", metadata.GetProperty("provider").GetString());
        Assert.True(metadata.GetProperty("configured").GetBoolean());

        using var result = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode);
        await AssertCodeAsync(result, "speech_not_configured");
    }

    [Theory]
    [InlineData("mr-IN", "mr-IN-AarohiNeural")]
    [InlineData("hi-IN", "hi-IN-SwaraNeural")]
    [InlineData("en-IN", "en-IN-NeerjaNeural")]
    public async Task UsesFixedVoicesEscapesTextAndKeepsSpeechCredentialsSeparate(string language, string expectedVoice)
    {
        const string text = "नमस्कार <voice name='intruder'> & 2 > 1";
        var wav = Wav();
        var transport = new InspectHandler(async request =>
        {
            Assert.Equal("https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1", request.RequestUri!.AbsoluteUri);
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("unit-test-azure-key", Assert.Single(request.Headers.GetValues("Ocp-Apim-Subscription-Key")));
            Assert.Null(request.Headers.Authorization);
            Assert.Equal("riff-24khz-16bit-mono-pcm", Assert.Single(request.Headers.GetValues("X-Microsoft-OutputFormat")));
            Assert.Equal("application/ssml+xml", request.Content!.Headers.ContentType!.MediaType);
            var xml = XDocument.Parse(await request.Content.ReadAsStringAsync());
            var voice = Assert.Single(xml.Descendants(), node => node.Name.LocalName == "voice");
            Assert.Equal(expectedVoice, voice.Attribute("name")!.Value);
            Assert.Equal(text, voice.Value);
            Assert.DoesNotContain(xml.Descendants(), node => node.Attribute("name")?.Value == "intruder");
            return Audio(wav);
        });
        using var root = new DadusFactory();
        using var factory = Configure(root, transport,
            new() { ["DadusGemini:ApiKey"] = "never-use-gemini-key", ["DadusOpenAI:ApiKey"] = "never-use-openai-key" });
        using var client = SessionClient(factory);

        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text, language });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("audio/wav", response.Content.Headers.ContentType!.MediaType);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(wav, await response.Content.ReadAsByteArrayAsync());
        Assert.Equal(1, transport.Calls);
    }

    [Theory]
    [InlineData("", "mr-IN", "invalid_speech_text")]
    [InlineData("   ", "mr-IN", "invalid_speech_text")]
    [InlineData("Hi\u0000there", "en-IN", "invalid_speech_text")]
    [InlineData("Hello", "fr-FR", "invalid_speech_language")]
    [InlineData("Hello", "", "invalid_speech_language")]
    [InlineData("Hello", "mr-IN<voice/>", "invalid_speech_language")]
    public async Task InvalidInputCannotReachTheProvider(string text, string language, string code)
    {
        var transport = new InspectHandler(_ => throw new Exception("Invalid input must not reach provider."));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text, language });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        await AssertCodeAsync(response, code);
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task OversizedInputAndMissingSessionAreRejectedBeforeProviderUse()
    {
        var transport = new InspectHandler(_ => throw new Exception("Invalid request must not reach provider."));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var oversized = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = new string('a', 1001), language = "en-IN" });
        Assert.Equal(HttpStatusCode.BadRequest, oversized.StatusCode);
        await AssertCodeAsync(oversized, "invalid_speech_text");
        using var noSession = factory.CreateClient();
        using var missing = await noSession.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        await AssertCodeAsync(missing, "invalid_session");
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData("centralindia.evil.test/path")]
    [InlineData("https://centralindia")]
    [InlineData("centralindia:443")]
    [InlineData("centralindia\r\nX-Injected: yes")]
    public async Task ARegionCannotRedirectSpeechCredentials(string region)
    {
        var transport = new InspectHandler(_ => throw new Exception("Invalid region must not reach provider."));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport, new() { ["DadusAzureSpeech:Region"] = region });
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        await AssertCodeAsync(response, "speech_not_configured");
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData(302, 502, "speech_provider_unavailable")]
    [InlineData(401, 502, "speech_authentication_failed")]
    [InlineData(403, 502, "speech_authentication_failed")]
    [InlineData(429, 429, "speech_rate_limited")]
    [InlineData(503, 502, "speech_provider_unavailable")]
    public async Task ProviderFailuresNeverExposeRawBodiesOrCredentials(int providerStatus, int expectedStatus, string expectedCode)
    {
        var transport = new InspectHandler(_ => Task.FromResult(new HttpResponseMessage((HttpStatusCode)providerStatus)
        {
            Content = new StringContent("private provider detail unit-test-azure-key never show me")
        }));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal((HttpStatusCode)expectedStatus, response.StatusCode);
        await AssertCodeAsync(response, expectedCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("private provider detail", body);
        Assert.DoesNotContain("unit-test-azure-key", body);
    }

    [Theory]
    [InlineData("not-wav")]
    [InlineData("truncated")]
    [InlineData("wrong-rate")]
    [InlineData("oversized")]
    public async Task UnusableProviderAudioIsRejected(string kind)
    {
        var data = kind switch
        {
            "not-wav" => Encoding.UTF8.GetBytes("This is not WAV audio."),
            "truncated" => Wav()[..45],
            "oversized" => new byte[4 * 1024 * 1024 + 1],
            _ => Wav()
        };
        if (kind == "wrong-rate") BitConverter.GetBytes(8000).CopyTo(data, 24);
        var transport = new InspectHandler(_ => Task.FromResult(Audio(data)));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "नमस्कार", language = "mr-IN" });
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        await AssertCodeAsync(response, "invalid_speech_audio");
    }

    [Fact]
    public async Task CallerCancellationCancelsTheProviderRequest()
    {
        var transport = new CancellationHandler();
        using var http = new HttpClient(transport);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Speech:Provider"] = "Azure",
            ["DadusAzureSpeech:ApiKey"] = "unit-test-azure-key",
            ["DadusAzureSpeech:Region"] = "centralindia"
        }).Build();
        var service = new AzureSpeechService(http, configuration);
        using var cancellation = new CancellationTokenSource();
        var operation = service.SynthesizeAsync("नमस्कार", "mr-IN", cancellation.Token);
        await transport.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.True(transport.Cancelled);
    }

    [Fact]
    public async Task ATransportTimeoutIsReportedWithoutRawTransportDetails()
    {
        var transport = new InspectHandler(_ => throw new TaskCanceledException("private transport timeout details"));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        await AssertCodeAsync(response, "speech_timeout");
        Assert.DoesNotContain("private transport timeout details", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task SpeechRateLimitDoesNotSpendTheChatRateLimit()
    {
        var transport = new InspectHandler(_ => throw new Exception("No provider request expected."));
        using var root = new DadusFactory();
        using var factory = Configure(root, transport, new() { ["DadusAzureSpeech:ApiKey"] = "" });
        await InitializeAsync(factory);
        using var client = SessionClient(factory);
        for (var index = 0; index < 12; index++)
        {
            using var attempt = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
            Assert.Equal(HttpStatusCode.ServiceUnavailable, attempt.StatusCode);
        }
        using var limited = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        await AssertCodeAsync(limited, "speech_rate_limited");
        Assert.Equal("60", Assert.Single(limited.Headers.GetValues("Retry-After")));
        using var chat = await client.PostAsJsonAsync("/api/chat/message", new { message = "Hello", language = "en" });
        Assert.Equal(HttpStatusCode.OK, chat.StatusCode);
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task AnUndeclaredAudioLengthIsBoundedWhileDownloading()
    {
        var source = new OversizedAudioStream();
        var transport = new InspectHandler(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(source) };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
            Assert.Null(response.Content.Headers.ContentLength);
            return Task.FromResult(response);
        });
        using var root = new DadusFactory();
        using var factory = Configure(root, transport);
        using var client = SessionClient(factory);
        using var response = await client.PostAsJsonAsync("/api/speech/synthesize", new { text = "Hello", language = "en-IN" });
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        await AssertCodeAsync(response, "invalid_speech_audio");
        Assert.InRange(source.ReadBytes, 4 * 1024 * 1024 + 1, 4 * 1024 * 1024 + 8192);
        Assert.True(source.Disposed);
    }

    [Fact]
    public async Task CallerCancellationAlsoStopsAnInProgressAudioDownload()
    {
        var source = new BlockingAudioStream();
        var transport = new InspectHandler(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(source) };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
            return Task.FromResult(response);
        });
        using var http = new HttpClient(transport);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Speech:Provider"] = "Azure",
            ["DadusAzureSpeech:ApiKey"] = "unit-test-azure-key",
            ["DadusAzureSpeech:Region"] = "centralindia"
        }).Build();
        var service = new AzureSpeechService(http, configuration);
        using var cancellation = new CancellationTokenSource();
        var operation = service.SynthesizeAsync("नमस्कार", "mr-IN", cancellation.Token);
        await source.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.True(source.Cancelled);
        Assert.True(source.Disposed);
    }

    private static WebApplicationFactory<Program> Configure(DadusFactory root, InspectHandler transport,
        Dictionary<string, string?>? overrides = null) => root.WithWebHostBuilder(builder =>
    {
        var settings = new Dictionary<string, string?>
        {
            ["Speech:Provider"] = "Azure",
            ["DadusAzureSpeech:ApiKey"] = "unit-test-azure-key",
            ["DadusAzureSpeech:Region"] = "centralindia"
        };
        if (overrides is not null)
            foreach (var pair in overrides) settings[pair.Key] = pair.Value;
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(settings));
        builder.ConfigureServices(services => services.AddHttpClient<AzureSpeechService>()
            .ConfigurePrimaryHttpMessageHandler(() => transport));
    });

    private static async Task InitializeAsync(WebApplicationFactory<Program> factory)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Dadus.Api.Data.DadusDbContext>().Database.EnsureCreatedAsync();
    }

    private static HttpClient SessionClient(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Dadus-Session", Guid.NewGuid().ToString());
        return client;
    }

    private static async Task AssertCodeAsync(HttpResponseMessage response, string expected)
    {
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, body.GetProperty("code").GetString());
    }

    private static HttpResponseMessage Audio(byte[] data)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(data) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        return response;
    }

    private static byte[] Wav()
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: true);
        writer.Write(Encoding.ASCII.GetBytes("RIFF"));
        writer.Write(40);
        writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        writer.Write(16);
        writer.Write((ushort)1);
        writer.Write((ushort)1);
        writer.Write(24000);
        writer.Write(48000);
        writer.Write((ushort)2);
        writer.Write((ushort)16);
        writer.Write(Encoding.ASCII.GetBytes("data"));
        writer.Write(4);
        writer.Write((short)0);
        writer.Write((short)100);
        return stream.ToArray();
    }

    private sealed class InspectHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> inspect) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            return inspect(request);
        }
    }

    private sealed class CancellationHandler : HttpMessageHandler
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Cancelled { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Started.SetResult();
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            catch (OperationCanceledException) { Cancelled = true; throw; }
            throw new InvalidOperationException("The infinite operation unexpectedly finished.");
        }
    }

    private abstract class ReadOnlyAudioStream : Stream
    {
        public bool Disposed { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }

    private sealed class OversizedAudioStream : ReadOnlyAudioStream
    {
        public int ReadBytes { get; private set; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var count = Math.Min(buffer.Length, 10 * 1024 * 1024 - ReadBytes);
            buffer.Span[..count].Clear();
            ReadBytes += count;
            return ValueTask.FromResult(count);
        }
    }

    private sealed class BlockingAudioStream : ReadOnlyAudioStream
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Cancelled { get; private set; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Started.SetResult();
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            catch (OperationCanceledException) { Cancelled = true; throw; }
            return 0;
        }
    }
}
