<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Integration\Symfony;

use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\Context\VisitorExtractor;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\HttpKernel\TerminableInterface;

/**
 * Decorates the application HTTP kernel so every request runs in a visitor scope that is
 * restored afterwards, including in long-running workers. A sub-request without its own
 * visitor ID inherits the outer request's visitor.
 */
final class VisitorContextKernel implements HttpKernelInterface, TerminableInterface
{
    public function __construct(
        private readonly HttpKernelInterface $inner,
        private readonly VisitorContextInterface $context,
    ) {}

    public function handle(Request $request, int $type = HttpKernelInterface::MAIN_REQUEST, bool $catch = true): Response
    {
        $cookie = $request->cookies->get(VisitorExtractor::COOKIE);
        $visitorId = VisitorExtractor::fromNormalized(
            $request->headers->all(),
            [VisitorExtractor::COOKIE => is_string($cookie) ? $cookie : null],
        );
        if ($visitorId === null && $type === HttpKernelInterface::SUB_REQUEST) {
            $visitorId = $this->context->current();
        }

        return $this->context->runWithVisitorId($visitorId, fn(): Response => $this->inner->handle($request, $type, $catch));
    }

    public function terminate(Request $request, Response $response): void
    {
        if ($this->inner instanceof TerminableInterface) {
            $this->inner->terminate($request, $response);
        }
    }
}
