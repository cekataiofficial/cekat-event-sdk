<?php

declare(strict_types=1);

namespace Cekat\EventSdk;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;
use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\ResponseDecodeException;
use Cekat\EventSdk\Exception\TransportException;
use Cekat\EventSdk\Exception\ValidationException;
use Cekat\EventSdk\Internal\PayloadBuilder;
use Cekat\EventSdk\Internal\ResponseDecoder;
use Cekat\EventSdk\Internal\RetryPolicy;
use Cekat\EventSdk\Internal\Sleeper;
use Cekat\EventSdk\Internal\SystemSleeper;
use Cekat\EventSdk\Transport\GuzzleTransport;
use Cekat\EventSdk\Transport\Transport;
use Cekat\EventSdk\Transport\TransportFailure;
use Cekat\EventSdk\Transport\TransportRequest;

/**
 * Submits Cekat events synchronously. Construct one client and reuse it.
 *
 * Every method returns an Acknowledgement (accepted for asynchronous processing) or throws:
 * ValidationException before any request; AuthenticationException (401),
 * EventDefinitionNotFoundException (404), or ApiException for other non-200 responses;
 * ResponseDecodeException for an invalid or unreadable 200; TransportException when no
 * response was received. Retries may create duplicate events; each retry reuses the event ID.
 */
final class Client
{
    public const VERSION = '0.2.0';

    private const INGEST_PATH = '/api/events/ingest';

    private readonly ClientOptions $options;
    private readonly Transport $transport;
    private readonly VisitorContextInterface $visitorContext;
    private readonly Sleeper $sleeper;
    /** @var \Closure(int): int */
    private readonly \Closure $random;
    private readonly PayloadBuilder $payloads;

    /**
     * @param Sleeper|null $sleeper @internal Test seam.
     * @param (\Closure(int): int)|null $random @internal Test seam returning an integer in [0, max].
     * @param PayloadBuilder|null $payloads @internal Test seam.
     *
     * @throws ValidationException
     */
    public function __construct(
        #[\SensitiveParameter]
        private readonly string $accessToken,
        ?ClientOptions $options = null,
        ?Transport $transport = null,
        ?VisitorContextInterface $visitorContext = null,
        ?Sleeper $sleeper = null,
        ?\Closure $random = null,
        ?PayloadBuilder $payloads = null,
    ) {
        if (trim($accessToken) === '') {
            throw new ValidationException('access token must not be blank');
        }
        $this->options = $options ?? new ClientOptions();
        $this->transport = $transport ?? new GuzzleTransport();
        $this->visitorContext = $visitorContext ?? VisitorContext::shared();
        $this->sleeper = $sleeper ?? new SystemSleeper();
        $this->random = $random ?? static fn(int $max): int => random_int(0, $max);
        $this->payloads = $payloads ?? new PayloadBuilder();
    }

    /** Submits the common user_registration event. */
    public function userRegistration(EventInput $event): Acknowledgement
    {
        return $this->track('user_registration', true, $event);
    }

    /** Submits the common user_login event. */
    public function userLogin(EventInput $event): Acknowledgement
    {
        return $this->track('user_login', true, $event);
    }

    /** Submits the common order_created event. */
    public function orderCreated(EventInput $event): Acknowledgement
    {
        return $this->track('order_created', true, $event);
    }

    /**
     * Submits the common order_paid event. The required finite $amount and nonblank $currency
     * are sent as the "amount" and "currency" properties; $event->properties must not already
     * contain either key. Currency codes are not validated by the SDK.
     */
    public function orderPaid(int|float $amount, string $currency, EventInput $event): Acknowledgement
    {
        return $this->track('order_paid', true, PayloadBuilder::withOrderPaidProperties($amount, $currency, $event));
    }

    /** Submits an event using a caller-provided event key. */
    public function customEvent(string $eventKey, EventInput $event): Acknowledgement
    {
        return $this->track($eventKey, false, $event);
    }

    private function track(string $eventKey, bool $isCommon, EventInput $event): Acknowledgement
    {
        // Encoded once so every retry sends the same event ID and timestamp.
        $body = $this->payloads->build($eventKey, $isCommon, $event, $this->visitorContext->current());
        $request = new TransportRequest('POST', $this->options->baseUrl . self::INGEST_PATH, [
            'Authorization' => 'Bearer ' . $this->accessToken,
            'Content-Type' => 'application/json',
            'User-Agent' => 'cekat-event-sdk-php/' . self::VERSION . ' php/' . PHP_VERSION,
        ], $body);

        return $this->deliver($request);
    }

    /**
     * @throws ApiException|ResponseDecodeException|TransportException
     */
    private function deliver(TransportRequest $request): Acknowledgement
    {
        $maximumAttempts = $this->options->retryCount + 1;
        for ($attempt = 1; ; $attempt++) {
            try {
                $response = $this->transport->send($request, $this->options->timeoutSeconds);
            } catch (TransportFailure $failure) {
                if ($attempt >= $maximumAttempts) {
                    throw new TransportException('Cekat API request failed before a response was received', $attempt, $failure);
                }
                $this->backoff($attempt, null);
                continue;
            }

            // Retry is decided by status alone, even when the body read failed.
            if ($attempt < $maximumAttempts && RetryPolicy::isRetryableStatus($response->status)) {
                $retryAfter = RetryPolicy::parseRetryAfterMilliseconds($response->header('Retry-After'), (int) floor(microtime(true) * 1000));
                if ($retryAfter === null || $retryAfter <= RetryPolicy::MAXIMUM_RETRY_AFTER_MS) {
                    $this->backoff($attempt, $retryAfter);
                    continue;
                }
                // The server asked for a longer pause than a caller should wait: report it now.
            }

            return ResponseDecoder::decode($response, $attempt);
        }
    }

    private function backoff(int $retry, ?int $retryAfterMilliseconds): void
    {
        $jitter = ($this->random)(RetryPolicy::delayBoundMilliseconds($retry));
        $this->sleeper->sleepMilliseconds(max($jitter, $retryAfterMilliseconds ?? 0));
    }
}
