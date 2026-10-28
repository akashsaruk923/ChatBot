using Dadus.Api;
using Dadus.Api.Data;
using Dadus.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Dadus.Api.Tests;

internal sealed class DadusFactory(IChatResponder? responder = null, string mode = "Demo", string environment = "Development") : WebApplicationFactory<Program>
{
    private readonly SqliteConnection _connection = OpenConnection();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["ConnectionStrings:Dadus"] = "Server=unused;Database=unused;Integrated Security=true",
                ["Chat:Mode"] = mode,
                ["DadusOpenAI:ApiKey"] = "",
                ["DadusGemini:ApiKey"] = ""
            }));
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<DadusDbContext>();
            services.RemoveAll<DbContextOptions<DadusDbContext>>();
            foreach (var descriptor in services.Where(descriptor =>
                         descriptor.ServiceType.IsGenericType &&
                         descriptor.ServiceType.Name.StartsWith("IDbContextOptionsConfiguration", StringComparison.Ordinal) &&
                         descriptor.ServiceType.GenericTypeArguments.Contains(typeof(DadusDbContext))).ToArray())
                services.Remove(descriptor);
            services.AddDbContext<DadusDbContext>(options => options.UseSqlite(_connection));
            if (responder is not null)
            {
                services.RemoveAll<IChatResponder>();
                services.AddSingleton(responder);
            }
        });
    }

    public async Task InitializeDatabaseAsync()
    {
        await using var scope = Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<DadusDbContext>().Database.EnsureCreatedAsync();
    }

    public HttpClient CreateSessionClient(Guid? session = null)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add("X-Dadus-Session", (session ?? Guid.NewGuid()).ToString());
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) _connection.Dispose();
    }

    private static SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        connection.Open();
        return connection;
    }
}
