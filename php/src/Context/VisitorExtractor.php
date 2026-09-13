<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Context;

use Psr\Http\Message\ServerRequestInterface;

/**
 * Resolves the browser visitor ID: a nonblank X-Cekat-Visitor-ID header wins over a nonblank
 * _cekat_visitor_id cookie. Values are trimmed and otherwise not decoded.
 */
final class VisitorExtractor
{
    public const HEADER = 'X-Cekat-Visitor-ID';
    public const COOKIE = '_cekat_visitor_id';

    public static function fromPsrRequest(ServerRequestInterface $request): ?string
    {
        $cookieParams = $request->getCookieParams();
        $cookie = $cookieParams[self::COOKIE] ?? null;

        return self::fromValues(
            $request->getHeader(self::HEADER),
            $request->getHeader('Cookie'),
            is_string($cookie) ? $cookie : null,
        );
    }

    /**
     * Resolves from framework-neutral inputs. Header names are matched case-insensitively.
     *
     * @param array<string, string|null|list<string|null>> $headers
     * @param array<string, mixed> $cookies Parsed cookies, used when no Cookie header is supplied.
     */
    public static function fromNormalized(array $headers, array $cookies = []): ?string
    {
        $visitorHeaders = [];
        $cookieHeaders = [];
        foreach ($headers as $name => $value) {
            $lower = strtolower((string) $name);
            $values = is_array($value) ? $value : [$value];
            if ($lower === strtolower(self::HEADER)) {
                array_push($visitorHeaders, ...$values);
            } elseif ($lower === 'cookie') {
                array_push($cookieHeaders, ...$values);
            }
        }
        $cookie = $cookies[self::COOKIE] ?? null;

        return self::fromValues($visitorHeaders, $cookieHeaders, is_string($cookie) ? $cookie : null);
    }

    /**
     * Returns the first nonblank _cekat_visitor_id value in a raw Cookie header.
     */
    public static function fromCookieHeader(string $cookieHeader): ?string
    {
        foreach (explode(';', $cookieHeader) as $pair) {
            $separator = strpos($pair, '=');
            if ($separator === false || trim(substr($pair, 0, $separator)) !== self::COOKIE) {
                continue;
            }
            $visitorId = self::normalize(substr($pair, $separator + 1));
            if ($visitorId !== null) {
                return $visitorId;
            }
        }

        return null;
    }

    /** Trims a visitor ID; blank values become null. */
    public static function normalize(?string $visitorId): ?string
    {
        if ($visitorId === null) {
            return null;
        }
        $trimmed = trim($visitorId);

        return $trimmed === '' ? null : $trimmed;
    }

    /**
     * Raw Cookie headers are preferred over parsed cookies because frameworks may decode or
     * decrypt parsed values (for example Laravel's EncryptCookies drops unencrypted cookies).
     *
     * @param array<mixed> $visitorHeaders
     * @param array<mixed> $cookieHeaders
     */
    private static function fromValues(array $visitorHeaders, array $cookieHeaders, ?string $parsedCookie): ?string
    {
        foreach ($visitorHeaders as $value) {
            $visitorId = is_string($value) ? self::normalize($value) : null;
            if ($visitorId !== null) {
                return $visitorId;
            }
        }
        foreach ($cookieHeaders as $value) {
            $visitorId = is_string($value) ? self::fromCookieHeader($value) : null;
            if ($visitorId !== null) {
                return $visitorId;
            }
        }

        return self::normalize($parsedCookie);
    }
}
