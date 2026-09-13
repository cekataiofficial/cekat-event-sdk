<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Support;

/**
 * Serves scripted raw HTTP/1.1 responses from a child PHP process, one per connection.
 * Each script entry is ['raw' => string, 'close' => bool, 'delay_ms' => int].
 */
final class RawHttpServer
{
    /** @var resource */
    private $process;

    /** @param resource $process */
    private function __construct(public readonly string $origin, $process)
    {
        $this->process = $process;
    }

    /**
     * @param list<array{raw: string, delay_ms?: int}> $script
     */
    public static function start(array $script): self
    {
        $code = <<<'PHP'
            $script = json_decode(stream_get_contents(STDIN), true);
            $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
            fwrite(STDOUT, stream_socket_get_name($server, false) . "\n");
            fflush(STDOUT);
            foreach ($script as $entry) {
                $connection = @stream_socket_accept($server, 30);
                if ($connection === false) { break; }
                $request = '';
                while (!str_contains($request, "\r\n\r\n") && ($line = fgets($connection)) !== false) { $request .= $line; }
                if (preg_match('/content-length:\s*(\d+)/i', $request, $m) && (int) $m[1] > 0) { fread($connection, (int) $m[1]); }
                if (($entry['delay_ms'] ?? 0) > 0) { usleep($entry['delay_ms'] * 1000); }
                @fwrite($connection, $entry['raw']);
                fclose($connection);
            }
            PHP;
        $process = proc_open([PHP_BINARY, '-r', $code], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            throw new \RuntimeException('could not start raw HTTP server');
        }
        fwrite($pipes[0], json_encode($script, JSON_THROW_ON_ERROR));
        fclose($pipes[0]);
        $address = trim((string) fgets($pipes[1]));

        return new self('http://' . $address, $process);
    }

    public function stop(): void
    {
        proc_terminate($this->process);
        proc_close($this->process);
    }
}
