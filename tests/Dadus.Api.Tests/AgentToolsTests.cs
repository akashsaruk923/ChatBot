using System.Globalization;
using System.Text.Json;
using Dadus.Api.Services;
using Xunit;

namespace Dadus.Api.Tests;

public sealed class AgentToolsTests
{
    [Theory]
    [InlineData("2 + 3 * 4", "14")]
    [InlineData("(12 + 3) * 2", "30")]
    [InlineData("-(2 + 3) / 2", "-2.5")]
    [InlineData("--2 + -3", "-1")]
    [InlineData("0.1 + 0.2", "0.3")]
    [InlineData("1.5 / .5", "3")]
    public void CalculatorHonorsDecimalArithmeticAndPrecedence(string expression, string expected)
    {
        var result = Calculate(expression);
        Assert.Equal("calculate", result.Name);
        Assert.Equal($"{expression} = {expected}", result.Summary);
    }

    [Theory]
    [InlineData("1 / 0")]
    [InlineData("79228162514264337593543950335 + 1")]
    [InlineData("System.IO.File.ReadAllText('/secret')")]
    [InlineData("1; Process.Start('anything')")]
    [InlineData("Math.Pow(2, 10)")]
    [InlineData("1,5 + 2")]
    [InlineData("NaN")]
    [InlineData("1..2")]
    [InlineData("1 2")]
    [InlineData("(1 + 2")]
    [InlineData("")]
    public void CalculatorRejectsInvalidOrUnsupportedExpressions(string expression)
    {
        var result = Calculate(expression);
        Assert.StartsWith("Tool error:", result.Summary);
        Assert.True(result.Summary.Length <= 1000);
    }

    [Fact]
    public void CalculatorEnforcesInputDepthAndOperationBudgets()
    {
        Assert.Equal(new string('(', 16) + "1" + new string(')', 16) + " = 1",
            Calculate(new string('(', 16) + "1" + new string(')', 16)).Summary);
        Assert.StartsWith("Tool error:", Calculate(new string('(', 17) + "1" + new string(')', 17)).Summary);
        Assert.StartsWith("Tool error:", Calculate(new string('+', 129) + "1").Summary);
        Assert.StartsWith("Tool error:", Calculate("1" + new string(' ', 256)).Summary);
    }

    [Fact]
    public void CurrentTimeDefaultsToIndiaWithAnActualCurrentTimestamp()
    {
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);
        var result = Execute("get_current_time", "{}");
        Assert.Equal("get_current_time", result.Name);
        Assert.EndsWith("+05:30 (Asia/Kolkata)", result.Summary);
        var timestamp = DateTimeOffset.Parse(result.Summary.Split(" (")[0], CultureInfo.InvariantCulture);
        Assert.InRange(timestamp.ToUniversalTime(), before, DateTimeOffset.UtcNow.AddSeconds(1));
    }

    [Fact]
    public void CurrentTimeAcceptsUtcAndRejectsUnknownZone()
    {
        Assert.EndsWith("+00:00 (UTC)", Execute("get_current_time", "{\"timezone\":\"UTC\"}").Summary);
        Assert.StartsWith("Tool error:", Execute("get_current_time", "{\"timezone\":\"Not/A_Zone\"}").Summary);
    }

    [Theory]
    [InlineData("calculate", "[]")]
    [InlineData("calculate", "{}")]
    [InlineData("calculate", "{\"expression\":123}")]
    [InlineData("calculate", "{\"expression\":\"1+2\",\"path\":\"/secret\"}")]
    [InlineData("calculate", "{\"expression\":\"1+2\",\"expression\":\"4+5\"}")]
    [InlineData("get_current_time", "{\"timezone\":null}")]
    [InlineData("get_current_time", "{\"timezone\":\"\"}")]
    [InlineData("get_current_time", "{\"timezone\":\"UTC\",\"command\":\"whoami\"}")]
    public void ToolArgumentsMustMatchTheSupportedSchema(string tool, string arguments)
    {
        Assert.StartsWith("Tool error:", Execute(tool, arguments).Summary);
    }

    [Fact]
    public void UnknownToolReturnsSafeBoundedErrorWithoutEchoingItsName()
    {
        var result = Execute(new string('x', 5000), "{}");
        Assert.Equal("unknown", result.Name);
        Assert.StartsWith("Tool error:", result.Summary);
        Assert.True(result.Summary.Length <= 1000);
    }

    [Fact]
    public void CancellationIsNotConvertedIntoAToolError()
    {
        using var token = new CancellationTokenSource();
        token.Cancel();
        using var json = JsonDocument.Parse("{\"expression\":\"1+2\"}");
        Assert.Throws<OperationCanceledException>(() => AgentTools.Execute("calculate", json.RootElement, token.Token));
    }

    [Fact]
    public void AdvertisedToolsUseClosedFunctionSchemas()
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(AgentTools.Definitions));
        var tools = json.RootElement.EnumerateArray().ToArray();
        Assert.Equal(new[] { "calculate", "get_current_time" },
            tools.Select(tool => tool.GetProperty("function").GetProperty("name").GetString()));
        Assert.All(tools, tool =>
        {
            Assert.Equal("function", tool.GetProperty("type").GetString());
            Assert.False(tool.GetProperty("function").GetProperty("parameters").GetProperty("additionalProperties").GetBoolean());
        });
    }

    private static ToolExecution Calculate(string expression)
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(new { expression }));
        return AgentTools.Execute("calculate", json.RootElement, default);
    }

    private static ToolExecution Execute(string tool, string arguments)
    {
        using var json = JsonDocument.Parse(arguments);
        return AgentTools.Execute(tool, json.RootElement, default);
    }
}
