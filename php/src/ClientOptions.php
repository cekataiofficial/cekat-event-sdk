<?php

declare(strict_types=1);

namespace Cekat\EventSdk;

use Cekat\EventSdk\Exception\ValidationException;

/**
 * Optional client configuration. Invalid values throw ValidationException on construction.
 */
final readonly class ClientOptions
{
    public const DEFAULT_BASE_URL = 'https://server.cekat.ai';

    /** Absolute HTTP(S) origin without a trailing slash. */
    public string $baseUrl;

    /**
     * @param string $baseUrl Absolute HTTP(S) origin with no credentials, path, query, or fragment.
     * @param float $timeoutSeconds Timeout applied to each network attempt.
     * @param int $retryCount Retries after the initial attempt.
     */
    public function __construct(
        string $baseUrl = self::DEFAULT_BASE_URL,
        public float $timeoutSeconds = 3.0,
        public int $retryCount = 2,
    ) {
        $this->baseUrl = self::normalizeOrigin($baseUrl);
        if (!is_finite($timeoutSeconds) || $timeoutSeconds <= 0) {
            throw new ValidationException('timeout must be a finite number of seconds greater than zero');
        }
        if ($retryCount < 0 || $retryCount === PHP_INT_MAX) {
            throw new ValidationException('retry count must be a nonnegative integer');
        }
    }

    private static function normalizeOrigin(string $baseUrl): string
    {
        $invalid = new ValidationException('base URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment');
        if (str_contains($baseUrl, '?') || str_contains($baseUrl, '#') || preg_match('/\s/', $baseUrl) === 1) {
            throw $invalid;
        }
        $parts = parse_url($baseUrl);
        if (!is_array($parts)) {
            throw $invalid;
        }
        $scheme = strtolower($parts['scheme'] ?? '');
        $host = $parts['host'] ?? '';
        $path = $parts['path'] ?? '';
        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || isset($parts['user']) || isset($parts['pass']) || ($path !== '' && $path !== '/')) {
            throw $invalid;
        }

        return $scheme . '://' . strtolower($host) . (isset($parts['port']) ? ':' . $parts['port'] : '');
    }
}
