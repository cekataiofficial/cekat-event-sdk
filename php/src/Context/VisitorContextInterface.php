<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Context;

use Psr\Http\Message\ServerRequestInterface;

/**
 * Request-local visitor state. Implementations must restore prior state when a scope ends,
 * including when the handler throws, so long-running workers never leak a visitor ID.
 *
 * The default VisitorContext is safe for PHP-FPM and sequential workers (Octane, RoadRunner,
 * FrankenPHP). Servers that interleave requests in one process with coroutines must provide
 * a coroutine-local implementation instead of sharing VisitorContext.
 */
interface VisitorContextInterface
{
    /** The visitor ID of the current scope, or null. */
    public function current(): ?string;

    /** Sets the current visitor ID (trimmed; blank means none) and returns the previous value. */
    public function replace(?string $visitorId): ?string;

    /** Restores a value previously returned by replace(). */
    public function restore(?string $previous): void;

    /**
     * Runs $handler with $visitorId as the current visitor, restoring the previous value afterwards.
     *
     * @template T
     * @param callable(): T $handler
     * @return T
     */
    public function runWithVisitorId(?string $visitorId, callable $handler): mixed;

    /**
     * Extracts the visitor from $request (header before cookie) and runs $handler in that scope.
     *
     * @template T
     * @param callable(): T $handler
     * @return T
     */
    public function runWithPsrRequest(ServerRequestInterface $request, callable $handler): mixed;
}
