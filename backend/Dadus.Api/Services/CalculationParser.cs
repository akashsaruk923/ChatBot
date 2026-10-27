using System.Globalization;

namespace Dadus.Api.Services;

/// <summary>A bounded decimal arithmetic parser; never evaluates executable code.</summary>
internal sealed class CalculationParser
{
    private readonly string expression;
    private readonly CancellationToken cancellationToken;
    private int position;
    private int depth;
    private int operations;

    private CalculationParser(string expression, CancellationToken cancellationToken)
    {
        this.expression = expression;
        this.cancellationToken = cancellationToken;
    }

    public static decimal Evaluate(string expression, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(expression) || expression.Length > 256)
            throw new FormatException("Provide an expression between 1 and 256 characters.");
        var parser = new CalculationParser(expression, cancellationToken);
        var result = parser.Expression();
        parser.SkipWhitespace();
        if (parser.position != expression.Length)
            throw InvalidExpression();
        return result;
    }

    private decimal Expression()
    {
        var value = Term();
        while (true)
        {
            SkipWhitespace();
            if (Take('+'))
            {
                Operation();
                value += Term();
            }
            else if (Take('-'))
            {
                Operation();
                value -= Term();
            }
            else return value;
        }
    }

    private decimal Term()
    {
        var value = Unary();
        while (true)
        {
            SkipWhitespace();
            if (Take('*'))
            {
                Operation();
                value *= Unary();
            }
            else if (Take('/'))
            {
                Operation();
                value /= Unary();
            }
            else return value;
        }
    }

    private decimal Unary()
    {
        var negative = false;
        while (true)
        {
            SkipWhitespace();
            if (Take('+')) Operation();
            else if (Take('-'))
            {
                Operation();
                negative = !negative;
            }
            else break;
        }
        var value = Primary();
        return negative ? -value : value;
    }

    private decimal Primary()
    {
        cancellationToken.ThrowIfCancellationRequested();
        SkipWhitespace();
        if (Take('('))
        {
            if (++depth > 16)
                throw new FormatException("Expressions may contain at most 16 nested parentheses.");
            var value = Expression();
            SkipWhitespace();
            if (!Take(')')) throw InvalidExpression();
            depth--;
            return value;
        }

        var start = position;
        while (position < expression.Length && (expression[position] is >= '0' and <= '9' or '.'))
        {
            cancellationToken.ThrowIfCancellationRequested();
            position++;
        }
        if (start == position || !decimal.TryParse(expression.AsSpan(start, position - start),
                NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var number))
            throw InvalidExpression();
        return number;
    }

    private void Operation()
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (++operations > 128)
            throw new FormatException("Expressions may contain at most 128 arithmetic operations.");
    }

    private bool Take(char token)
    {
        if (position >= expression.Length || expression[position] != token) return false;
        position++;
        return true;
    }

    private void SkipWhitespace()
    {
        while (position < expression.Length && char.IsWhiteSpace(expression[position]))
        {
            cancellationToken.ThrowIfCancellationRequested();
            position++;
        }
    }

    private static FormatException InvalidExpression() =>
        new("Use decimal numbers, +, -, *, / and balanced parentheses only.");
}
