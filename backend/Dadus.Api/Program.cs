using System.Globalization;
using System.Data.Common;
using System.Threading.RateLimiting;
using Dadus.Api.Data;
using Dadus.Api.Services;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 64 * 1024);
builder.Services.Configure<Microsoft.AspNetCore.Routing.RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
builder.Services.Configure<JsonOptions>(options => options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);
builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
    context.ProblemDetails.Extensions.TryAdd("code", "invalid_request"));
builder.Services.AddDbContext<DadusDbContext>(options =>
{
    var connection = builder.Configuration.GetConnectionString("Dadus");
    var provider = builder.Configuration["Database:Provider"] ?? "SqlServer";
    if (string.Equals(provider, "Sqlite", StringComparison.OrdinalIgnoreCase))
    {
        if (!builder.Environment.IsDevelopment())
            throw new InvalidOperationException("SQLite storage is restricted to Development.");
        var localDirectory = Path.Combine(builder.Environment.ContentRootPath, ".local");
        Directory.CreateDirectory(localDirectory);
        options.UseSqlite(connection ?? $"Data Source={Path.Combine(localDirectory, "dadus.db")}");
    }
    else if (string.Equals(provider, "SqlServer", StringComparison.OrdinalIgnoreCase))
    {
        options.UseSqlServer(connection ?? "Server=127.0.0.1,1433;Database=Dadus;Integrated Security=true;Encrypt=true", sql => sql.CommandTimeout(15));
    }
    else
    {
        throw new InvalidOperationException("Database:Provider must be SqlServer or Sqlite.");
    }
});
builder.Services.AddSingleton<ConversationLocks>();
builder.Services.AddHttpClient<OpenAiChatResponder>(client => client.Timeout = TimeSpan.FromSeconds(45));
builder.Services.AddHttpClient<GeminiChatResponder>(client => client.Timeout = TimeSpan.FromSeconds(45));
builder.Services.AddScoped<IChatResponder>(services =>
{
    var mode = builder.Configuration["Chat:Mode"] ?? "OpenAI";
    if (string.Equals(mode, "Demo", StringComparison.OrdinalIgnoreCase))
    {
        if (!builder.Environment.IsDevelopment())
            throw new ChatFailure(503, "demo_not_allowed", "Demo mode is available only in the Development environment.");
        return new DemoChatResponder();
    }
    if (string.Equals(mode, "OpenAI", StringComparison.OrdinalIgnoreCase))
        return services.GetRequiredService<OpenAiChatResponder>();
    if (string.Equals(mode, "Gemini", StringComparison.OrdinalIgnoreCase))
        return services.GetRequiredService<GeminiChatResponder>();
    throw new ChatFailure(503, "invalid_chat_mode", "Select Demo, OpenAI or Gemini in the backend chat configuration.");
});
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy("chat", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "local",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 30,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        }));
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.Headers.RetryAfter = "60";
        await Results.Problem(statusCode: 429, title: "Too many requests", detail: "Please wait a minute before sending another message.",
            extensions: new Dictionary<string, object?> { ["code"] = "rate_limit_exceeded" }).ExecuteAsync(context.HttpContext);
    };
});

var app = builder.Build();

if (args.Contains("--migrate", StringComparer.Ordinal))
{
    using var scope = app.Services.CreateScope();
    var database = scope.ServiceProvider.GetRequiredService<DadusDbContext>().Database;
    // The optional SQLite database is disposable development storage. SQL Server uses migrations.
    if (database.IsSqlite()) await database.EnsureCreatedAsync();
    else await database.MigrateAsync();
    return;
}

app.UseExceptionHandler(exceptionApp => exceptionApp.Run(async context =>
{
    var error = context.Features.Get<IExceptionHandlerFeature>()?.Error;
    var (status, code, detail) = error switch
    {
        ChatFailure failure => (failure.Status, failure.Code, failure.Message),
        BadHttpRequestException badRequest => (badRequest.StatusCode, "invalid_request", "The request body or parameters are invalid."),
        DbUpdateException => (503, "database_unavailable", "Conversation storage is unavailable. Please try again later."),
        DbException => (503, "database_unavailable", "Conversation storage is unavailable. Please try again later."),
        _ => (500, "unexpected_error", "The server could not complete this request. Please try again later.")
    };
    if (status >= 500)
        app.Logger.LogWarning("Request failed with code {Code} ({ExceptionType}).", code, error?.GetType().Name);
    var extensions = new Dictionary<string, object?> { ["code"] = code };
    if (error is ChatFailure { ProviderStatus: >= 500 and <= 599 } providerFailure)
        extensions["providerStatus"] = providerFailure.ProviderStatus;
    await Results.Problem(statusCode: status, title: status >= 500 ? "Service unavailable" : "Request rejected", detail: detail,
        extensions: extensions).ExecuteAsync(context);
}));
app.UseRateLimiter();

app.MapGet("/api/health", async (DadusDbContext db, IChatResponder responder, CancellationToken cancellationToken) =>
{
    if (!await db.Database.CanConnectAsync(cancellationToken))
        return Results.Problem(statusCode: 503, title: "Storage unavailable", detail: "The database is not ready.",
            extensions: new Dictionary<string, object?> { ["code"] = "database_unavailable" });
    // A connection alone is insufficient: required tables must exist after migration.
    _ = await db.Conversations.AnyAsync(cancellationToken);
    _ = await db.Messages.AnyAsync(cancellationToken);
    var keySetting = responder.Mode switch
    {
        "openai" => "DadusOpenAI:ApiKey",
        "gemini" => "DadusGemini:ApiKey",
        _ => null
    };
    if (keySetting is not null)
        _ = ProviderKeyConfiguration.Require(builder.Configuration[keySetting], responder.Mode == "gemini" ? "Gemini" : "OpenAI");
    return Results.Ok(new { status = "ok", mode = responder.Mode, database = "ready" });
});

var chat = app.MapGroup("/api/chat");

app.MapGet("/api/agents", () => Results.Ok(new { agents = AgentCatalog.All }));

chat.MapPost("/message", async (ChatRequest request, HttpContext httpContext, DadusDbContext db,
    IChatResponder responder, ConversationLocks conversationLocks, CancellationToken cancellationToken) =>
{
    var session = Session(httpContext);
    var text = request.Message?.Trim();
    if (string.IsNullOrWhiteSpace(text) || text.Length > 4000)
        throw new ChatFailure(400, "invalid_message", "Enter a message between 1 and 4,000 characters.");
    var agentId = string.IsNullOrWhiteSpace(request.AgentId) ? "companion" : request.AgentId.Trim().ToLowerInvariant();
    if (!AgentCatalog.All.Any(agent => agent.Id == agentId))
        throw new ChatFailure(400, "invalid_agent", "Choose one of the available DADUS AI agents.");
    var language = ChatLanguage.Normalize(request.Language);
    var conversationId = request.ConversationId ?? Guid.NewGuid();
    if (conversationId == Guid.Empty)
        throw new ChatFailure(400, "invalid_conversation", "Choose a valid conversation.");

    var gate = conversationLocks.For(conversationId);
    await gate.WaitAsync(cancellationToken);
    try
    {
        Conversation conversation;
        if (request.ConversationId.HasValue)
        {
            conversation = await db.Conversations.SingleOrDefaultAsync(x => x.Id == conversationId && x.OwnerSessionId == session, cancellationToken)
                ?? throw new ChatFailure(404, "conversation_not_found", "The conversation was not found.");
        }
        else
        {
            conversation = new Conversation
            {
                Id = conversationId,
                OwnerSessionId = session,
                Title = ConversationTitle(text)
            };
        }

        var previous = await db.Messages.AsNoTracking().Where(x => x.ConversationId == conversationId)
            .OrderByDescending(x => x.CreatedAt).Take(20).ToListAsync(cancellationToken);
        previous.Reverse();
        var context = previous.Select(x => new ChatTurn(x.Role, x.Content)).ToList();
        context.Add(new ChatTurn("user", text));
        var agentReply = await responder.RunAgentAsync(agentId, context, language, cancellationToken);
        var reply = agentReply.Content;
        if (string.IsNullOrWhiteSpace(reply) || reply.Length > 12000)
            throw new ChatFailure(502, "invalid_provider_response", "The AI provider returned an unusable response.");

        // Save only complete exchanges. Monotonic timestamps make the history cursor unambiguous.
        var now = DateTime.UtcNow;
        var lastTimestamp = previous.LastOrDefault()?.CreatedAt;
        if (lastTimestamp.HasValue && now <= lastTimestamp.Value) now = lastTimestamp.Value.AddTicks(1);
        var userMessage = new ChatMessage { Id = Guid.NewGuid(), ConversationId = conversationId, Role = "user", Content = text, CreatedAt = now };
        var assistantMessage = new ChatMessage { Id = Guid.NewGuid(), ConversationId = conversationId, Role = "assistant", Content = reply, CreatedAt = now.AddTicks(1) };
        conversation.UpdatedAt = assistantMessage.CreatedAt;
        if (!request.ConversationId.HasValue) db.Conversations.Add(conversation);
        db.Messages.AddRange(userMessage, assistantMessage);
        await db.SaveChangesAsync(cancellationToken);
        return Results.Ok(new { conversationId, message = MessageDto(assistantMessage), mode = responder.Mode,
            agentId, language, tools = agentReply.Tools });
    }
    finally { gate.Release(); }
}).RequireRateLimiting("chat");

chat.MapGet("/conversations", async (HttpContext httpContext, DadusDbContext db, CancellationToken cancellationToken) =>
{
    var session = Session(httpContext);
    var conversations = await db.Conversations.AsNoTracking().Where(x => x.OwnerSessionId == session)
        .OrderByDescending(x => x.UpdatedAt).Take(100)
        .Select(x => new { x.Id, x.Title, x.UpdatedAt }).ToListAsync(cancellationToken);
    return Results.Ok(new { conversations });
});

chat.MapGet("/history", async (HttpContext httpContext, DadusDbContext db, CancellationToken cancellationToken) =>
{
    var session = Session(httpContext);
    if (!Guid.TryParse(httpContext.Request.Query["conversationId"], out var conversationId) || conversationId == Guid.Empty)
        throw new ChatFailure(400, "invalid_conversation", "A valid conversationId is required.");
    var limit = 50;
    if (httpContext.Request.Query.TryGetValue("limit", out var rawLimit) &&
        (!int.TryParse(rawLimit, out limit) || limit < 1 || limit > 100))
        throw new ChatFailure(400, "invalid_limit", "History limit must be between 1 and 100.");
    DateTime? before = null;
    if (httpContext.Request.Query.TryGetValue("before", out var rawBefore))
    {
        if (!DateTimeOffset.TryParse(rawBefore, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
            throw new ChatFailure(400, "invalid_cursor", "The history cursor must be an ISO timestamp.");
        before = parsed.UtcDateTime;
    }
    if (!await db.Conversations.AnyAsync(x => x.Id == conversationId && x.OwnerSessionId == session, cancellationToken))
        throw new ChatFailure(404, "conversation_not_found", "The conversation was not found.");
    var query = db.Messages.AsNoTracking().Where(x => x.ConversationId == conversationId);
    if (before.HasValue) query = query.Where(x => x.CreatedAt < before.Value);
    var messages = await query.OrderByDescending(x => x.CreatedAt).Take(limit + 1).ToListAsync(cancellationToken);
    var hasMore = messages.Count > limit;
    if (hasMore) messages.RemoveAt(messages.Count - 1);
    messages.Reverse();
    return Results.Ok(new { conversationId, messages = messages.Select(MessageDto), hasMore });
});

app.Run();

static Guid Session(HttpContext context)
{
    if (!Guid.TryParse(context.Request.Headers["X-Dadus-Session"], out var id) || id == Guid.Empty)
        throw new ChatFailure(400, "invalid_session", "A valid X-Dadus-Session header is required.");
    return id;
}

static object MessageDto(ChatMessage message) => new { message.Id, message.Role, message.Content, message.CreatedAt };

static string ConversationTitle(string text)
{
    if (text.Length <= 80) return text;
    // nvarchar(80) counts UTF-16 units. Keep a complete text element at the
    // boundary, including surrogate pairs and combining accents.
    var cutoff = Array.FindLast(StringInfo.ParseCombiningCharacters(text), boundary => boundary <= 80);
    return cutoff > 0 ? text[..cutoff] : "New conversation";
}

public sealed record ChatRequest(Guid? ConversationId, string? Message, string? AgentId = null, string? Language = null);
public partial class Program;
