namespace Dadus.Api.Services;

public static class ChatLanguage
{
    public static string Normalize(string? language)
    {
        var value = string.IsNullOrWhiteSpace(language) ? "auto" : language.Trim().ToLowerInvariant();
        return value is "auto" or "en" or "hi" or "mr" ? value
            : throw new ChatFailure(400, "invalid_language", "Choose Auto, English, Hindi or Marathi for the reply language.");
    }

    internal static string Instructions(string? language) => Normalize(language) switch
    {
        "mr" => "Current reply language: Marathi (मराठी). Write the answer naturally in Marathi using Devanagari. " +
                "This selection applies to this reply even when earlier messages or the latest question are in English or Hindi. " +
                "Keep code, identifiers, URLs, quoted source text and proper names unchanged when necessary. ",
        "hi" => "Current reply language: Hindi (हिन्दी). Write the answer naturally in Hindi using Devanagari. " +
                "This selection applies to this reply even when earlier messages or the latest question are in English or Marathi. " +
                "Keep code, identifiers, URLs, quoted source text and proper names unchanged when necessary. ",
        "en" => "Current reply language: English. Write the answer naturally in English. " +
                "This selection applies to this reply even when earlier messages or the latest question use another language. " +
                "Keep code, identifiers, URLs, quoted source text and proper names unchanged when necessary. ",
        _ => "Current reply language: Auto. Follow the language and style of the latest user message, rather than the language of older replies. " +
             "Understand Marathi and Hindi written with Roman letters, including phrases such as 'mala madat kar', 'tu kasa ahes' and 'mujhe madad chahiye'. " +
             "Roman letters alone do not mean English. Reply in the user's Marathi, Hindi, English or natural mixture, matching their script where practical. "
    };
}
