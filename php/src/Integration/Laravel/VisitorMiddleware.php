<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Integration\Laravel;

use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\Context\VisitorExtractor;
use Illuminate\Contracts\Container\Container;
use Illuminate\Http\Request;

/**
 * Laravel middleware that scopes the request visitor ID while the rest of the pipeline runs.
 * It reads the raw Cookie header, so it works before or after EncryptCookies without adding
 * _cekat_visitor_id to the encryption exceptions.
 */
final class VisitorMiddleware
{
    public function __construct(private readonly Container $container) {}

    public function handle(Request $request, \Closure $next): mixed
    {
        $cookie = $request->cookies->get(VisitorExtractor::COOKIE);
        $visitorId = VisitorExtractor::fromNormalized(
            $request->headers->all(),
            ['_cekat_visitor_id' => is_string($cookie) ? $cookie : null],
        );

        /** @var VisitorContextInterface $context */
        $context = $this->container->make(VisitorContextInterface::class);

        return $context->runWithVisitorId($visitorId, static fn(): mixed => $next($request));
    }
}
