<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Integration\Psr15;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * PSR-15 middleware (Slim, Mezzio, and other PSR-15 stacks) that scopes the request visitor ID
 * while downstream handlers run. It does not modify the request, response, or cookies.
 */
final class VisitorMiddleware implements MiddlewareInterface
{
    private readonly VisitorContextInterface $context;

    public function __construct(?VisitorContextInterface $context = null)
    {
        $this->context = $context ?? VisitorContext::shared();
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        return $this->context->runWithPsrRequest($request, static fn(): ResponseInterface => $handler->handle($request));
    }
}
