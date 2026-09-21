<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Packaging;

use Cekat\EventSdk\Client;
use PHPUnit\Framework\TestCase;

final class PackageScriptTest extends TestCase
{
    private const SCRIPT = __DIR__ . '/../../scripts/package';

    /**
     * @param list<string> $arguments
     * @return array{int, string}
     */
    private function runScript(array $arguments): array
    {
        $process = proc_open([PHP_BINARY, self::SCRIPT, ...$arguments], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);

        return [proc_close($process), $output];
    }

    public function testRejectsInvalidArgumentsBeforeRunningChecks(): void
    {
        $output = sys_get_temp_dir() . '/cekat-php-package-' . bin2hex(random_bytes(4));
        mkdir($output);
        file_put_contents($output . '/stale.zip', 'stale');
        try {
            foreach ([
                [],
                ['--version', '0.2.0'],
                ['--version', '0.1.1', '--output', sys_get_temp_dir()],
                ['--version', '0.2.0', '--output', 'relative'],
                ['--version', '0.2.0', '--output', sys_get_temp_dir() . '/../tmp'],
                ['--version', '0.2.0', '--output', $output],
            ] as $arguments) {
                [$status, $message] = $this->runScript($arguments);
                self::assertSame(2, $status, implode(' ', $arguments) . ': ' . $message);
                self::assertStringContainsString('usage', $message);
            }
        } finally {
            unlink($output . '/stale.zip');
            rmdir($output);
        }
    }

    public function testScriptVersionMatchesClientAndNeverPublishes(): void
    {
        $script = (string) file_get_contents(self::SCRIPT);
        self::assertStringContainsString("const VERSION = '" . Client::VERSION . "'", $script);
        foreach (['composer validate --strict', 'phpunit', 'phpstan', 'php-cs-fixer', 'composer audit', 'composer archive'] as $required) {
            self::assertStringContainsString($required, $script);
        }
        foreach (['publish', 'packagist.org/api', 'git push', 'git tag', 'gpg'] as $forbidden) {
            self::assertStringNotContainsString($forbidden, strtolower($script));
        }
    }
}
