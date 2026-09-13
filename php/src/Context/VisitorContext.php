<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Context;

use Psr\Http\Message\ServerRequestInterface;

/**
 * Default synchronous visitor context. Visitor IDs are untrusted correlation data and must
 * never be used for authentication, authorization, or resource ownership.
 */
final class VisitorContext implements VisitorContextInterface
{
    private static ?self $shared = null;

    private ?string $visitorId = null;

    /**
     * The process-wide default used by Client and VisitorMiddleware when no context is injected.
     */
    public static function shared(): self
    {
        return self::$shared ??= new self();
    }

    public function current(): ?string
    {
        return $this->visitorId;
    }

    public function replace(?string $visitorId): ?string
    {
        $previous = $this->visitorId;
        $this->visitorId = VisitorExtractor::normalize($visitorId);

        return $previous;
    }

    public function restore(?string $previous): void
    {
        $this->visitorId = $previous;
    }

    public function runWithVisitorId(?string $visitorId, callable $handler): mixed
    {
        $previous = $this->replace($visitorId);
        try {
            return $handler();
        } finally {
            $this->restore($previous);
        }
    }

    public function runWithPsrRequest(ServerRequestInterface $request, callable $handler): mixed
    {
        return $this->runWithVisitorId(VisitorExtractor::fromPsrRequest($request), $handler);
    }
}
