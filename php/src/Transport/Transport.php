<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Transport;

/**
 * Sends one HTTP attempt. Implementations must not retry or follow redirects.
 */
interface Transport
{
    /**
     * Returns a response once status and headers are received, even when the body read then
     * fails (reported through TransportResponse::$bodyReadFailure).
     *
     * @throws TransportFailure when no response status was received.
     */
    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse;
}
