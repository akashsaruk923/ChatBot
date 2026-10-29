using System.Buffers.Binary;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Dadus.Api.Services;

public sealed record SpeechConfiguration(string Provider, bool Configured, string[] Languages, int MaxTextLength);

/// <summary>Optional speech output; chat configuration and credentials remain independent.</summary>
public sealed class AzureSpeechService(HttpClient http, IConfiguration configuration)
{
    public const int MaxTextLength = 1000;
    public const int MaxAudioBytes = 4 * 1024 * 1024;
    private static readonly string[] Languages = ["mr-IN", "hi-IN", "en-IN"];
    private static readonly Dictionary<string, string> Voices = new(StringComparer.Ordinal)
    {
        ["mr-IN"] = "mr-IN-AarohiNeural",
        ["hi-IN"] = "hi-IN-SwaraNeural",
        ["en-IN"] = "en-IN-NeerjaNeural"
    };

    public SpeechConfiguration GetConfiguration()
    {
        var provider = configuration["Speech:Provider"]?.Trim() ?? "Browser";
        if (provider.Equals("Browser", StringComparison.OrdinalIgnoreCase))
            return new("browser", true, Languages, MaxTextLength);
        return new("azure", provider.Equals("Azure", StringComparison.OrdinalIgnoreCase) && TryCredentials(out _, out _), Languages, MaxTextLength);
    }

    public async Task<byte[]> SynthesizeAsync(string? text, string? language, CancellationToken cancellationToken)
    {
        text = text?.Trim();
        if (string.IsNullOrWhiteSpace(text) || text.Length > MaxTextLength)
            throw new ChatFailure(400, "invalid_speech_text", "Enter speech text between 1 and 1,000 characters.");
        try { XmlConvert.VerifyXmlChars(text); }
        catch (XmlException)
        {
            throw new ChatFailure(400, "invalid_speech_text", "The speech text contains unsupported characters.");
        }
        if (language is null || !Voices.TryGetValue(language, out var voice))
            throw new ChatFailure(400, "invalid_speech_language", "Choose Marathi, Hindi or English for speech playback.");
        if (!string.Equals(configuration["Speech:Provider"]?.Trim(), "Azure", StringComparison.OrdinalIgnoreCase)
            || !TryCredentials(out var key, out var region))
            throw new ChatFailure(503, "speech_not_configured", "Online voice is not configured. Set the backend Azure Speech key and region, then restart the API.");

        XNamespace synthesis = "http://www.w3.org/2001/10/synthesis";
        var ssml = new XElement(synthesis + "speak", new XAttribute("version", "1.0"),
            new XAttribute(XNamespace.Xml + "lang", language),
            new XElement(synthesis + "voice", new XAttribute("name", voice), text));
        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1");
        request.Headers.Add("Ocp-Apim-Subscription-Key", key);
        request.Headers.Add("X-Microsoft-OutputFormat", "riff-24khz-16bit-mono-pcm");
        request.Headers.UserAgent.ParseAdd("Dadus/1.0");
        request.Content = new StringContent(ssml.ToString(SaveOptions.DisableFormatting), Encoding.UTF8, "application/ssml+xml");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode) throw ProviderFailure(response.StatusCode);
            var mediaType = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant();
            if (mediaType is not ("audio/wav" or "audio/x-wav" or "audio/wave" or "audio/vnd.wave")
                || response.Content.Headers.ContentLength is > MaxAudioBytes)
                throw InvalidAudio();
            await using var source = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int count;
            while ((count = await source.ReadAsync(chunk, deadline.Token)) != 0)
            {
                if (buffer.Length + count > MaxAudioBytes) throw InvalidAudio();
                buffer.Write(chunk, 0, count);
            }
            var audio = buffer.ToArray();
            if (!IsValidWave(audio)) throw InvalidAudio();
            return audio;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ChatFailure(504, "speech_timeout", "Online voice took too long. Try reading the reply again shortly.");
        }
        catch (HttpRequestException)
        {
            throw new ChatFailure(502, "speech_provider_unavailable", "The speech service could not be reached. Check the backend internet connection and try again.");
        }
        catch (IOException)
        {
            throw new ChatFailure(502, "speech_provider_unavailable", "The speech audio could not be downloaded. Please try again shortly.");
        }
    }

    private bool TryCredentials(out string key, out string region)
    {
        key = "";
        region = configuration["DadusAzureSpeech:Region"]?.Trim().ToLowerInvariant() ?? "";
        // A single DNS label under Microsoft's fixed domain: no URL, path, port or arbitrary host.
        if (!Regex.IsMatch(region, "^[a-z][a-z0-9-]{0,62}$", RegexOptions.CultureInvariant)
            || region.EndsWith('-')) return false;
        try { key = ProviderKeyConfiguration.Require(configuration["DadusAzureSpeech:ApiKey"], "Azure Speech"); }
        catch (ChatFailure) { return false; }
        return key.Length <= 512
            && !key.StartsWith("YOUR_", StringComparison.OrdinalIgnoreCase)
            && !key.StartsWith("PASTE_", StringComparison.OrdinalIgnoreCase);
    }

    private static ChatFailure ProviderFailure(HttpStatusCode status) => status switch
    {
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new ChatFailure(502, "speech_authentication_failed",
            "Azure Speech rejected access. Check the backend speech key and its matching resource region."),
        HttpStatusCode.TooManyRequests => new ChatFailure(429, "speech_rate_limited",
            "The speech service quota or request limit was reached. Check the Azure F0 allowance and try again later."),
        _ => new ChatFailure(502, "speech_provider_unavailable", "The speech service could not generate audio. Please try again shortly.")
    };

    private static ChatFailure InvalidAudio() => new(502, "invalid_speech_audio", "The speech service returned unusable audio. Please try again shortly.");

    private static bool IsValidWave(ReadOnlySpan<byte> audio)
    {
        if (audio.Length < 46 || !audio[..4].SequenceEqual("RIFF"u8) || !audio.Slice(8, 4).SequenceEqual("WAVE"u8)
            || BinaryPrimitives.ReadUInt32LittleEndian(audio.Slice(4, 4)) != audio.Length - 8) return false;
        var hasFormat = false;
        var hasData = false;
        var offset = 12;
        while (offset < audio.Length)
        {
            if (audio.Length - offset < 8) return false;
            var length = BinaryPrimitives.ReadUInt32LittleEndian(audio.Slice(offset + 4, 4));
            var next = (long)offset + 8 + length + (length & 1);
            if (next > audio.Length) return false;
            var id = audio.Slice(offset, 4);
            if (id.SequenceEqual("fmt "u8))
            {
                if (hasFormat || length < 16) return false;
                var format = audio.Slice(offset + 8, 16);
                if (BinaryPrimitives.ReadUInt16LittleEndian(format[..2]) != 1
                    || BinaryPrimitives.ReadUInt16LittleEndian(format.Slice(2, 2)) != 1
                    || BinaryPrimitives.ReadUInt32LittleEndian(format.Slice(4, 4)) != 24000
                    || BinaryPrimitives.ReadUInt32LittleEndian(format.Slice(8, 4)) != 48000
                    || BinaryPrimitives.ReadUInt16LittleEndian(format.Slice(12, 2)) != 2
                    || BinaryPrimitives.ReadUInt16LittleEndian(format.Slice(14, 2)) != 16) return false;
                hasFormat = true;
            }
            else if (id.SequenceEqual("data"u8))
            {
                if (hasData || length < 2 || length % 2 != 0) return false;
                hasData = true;
            }
            offset = (int)next;
        }
        return hasFormat && hasData;
    }
}
