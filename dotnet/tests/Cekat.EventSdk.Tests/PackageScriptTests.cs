using System.Diagnostics;

namespace Cekat.EventSdk.Tests;

public sealed class PackageScriptTests
{
    private static readonly string DotnetDirectory = FindDotnetDirectory();
    private static readonly string Script = Path.Combine(DotnetDirectory, "scripts", "package");

    [Fact]
    public async Task PackageScript_rejects_invalid_arguments_before_running_checks()
    {
        var dirty = Directory.CreateTempSubdirectory("cekat-package-");
        await File.WriteAllTextAsync(Path.Combine(dirty.FullName, "stale.nupkg"), "stale");
        var temp = Path.GetTempPath().TrimEnd('/');
        string[][] cases =
        [
            [],
            ["--version", "0.1.0"],
            ["--version", "0.1.1", "--output", temp],
            ["--version", "0.1.0", "--output", "relative"],
            ["--version", "0.1.0", "--output", $"{temp}/../tmp"],
            ["--version", "0.1.0", "--output", dirty.FullName],
            ["--version", "0.1.0", "--output", Path.Combine(dirty.FullName, "stale.nupkg")],
            ["--version", "0.1.0", "--output", Path.Combine(DotnetDirectory, "artifacts-output")],
        ];
        try
        {
            foreach (var arguments in cases)
            {
                var (exitCode, error) = await RunAsync(arguments);
                Assert.True(exitCode == 2, $"[{string.Join(' ', arguments)}] exited {exitCode}: {error}");
                Assert.Contains("usage", error, StringComparison.Ordinal);
            }

            Assert.False(Directory.Exists(Path.Combine(DotnetDirectory, "artifacts-output")));
        }
        finally
        {
            dirty.Delete(recursive: true);
        }
    }

    [Fact]
    public void PackageScript_matches_the_package_version_and_never_publishes()
    {
        var source = File.ReadAllText(Script);
        Assert.Contains($"VERSION={CekatConstants.Version}", source, StringComparison.Ordinal);
        foreach (var required in new[] { "dotnet test", "--vulnerable", "dotnet pack", "manifest.json" })
        {
            Assert.Contains(required, source, StringComparison.Ordinal);
        }

        foreach (var forbidden in new[] { "nuget push", "dotnet nuget", "git tag", "git push", "sign " })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }
    }

    private static async Task<(int ExitCode, string Error)> RunAsync(string[] arguments)
    {
        var start = new ProcessStartInfo("sh") { RedirectStandardError = true, RedirectStandardOutput = true };
        start.ArgumentList.Add(Script);
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using var process = Process.Start(start)!;
        var error = await process.StandardError.ReadToEndAsync();
        await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (process.ExitCode, error);
    }

    private static string FindDotnetDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Cekat.EventSdk.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("Cekat.EventSdk.sln not found");
    }
}
