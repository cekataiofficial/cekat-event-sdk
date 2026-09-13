<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

use Cekat\EventSdk\Acknowledgement;
use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\AuthenticationException;
use Cekat\EventSdk\Exception\EventDefinitionNotFoundException;
use Cekat\EventSdk\Exception\ResponseDecodeException;
use Cekat\EventSdk\Transport\TransportResponse;

/**
 * Maps a received response to an acknowledgement or a typed exception.
 *
 * @internal
 */
final class ResponseDecoder
{
    /**
     * @throws ApiException|ResponseDecodeException
     */
    public static function decode(TransportResponse $response, int $attempts): Acknowledgement
    {
        if ($response->status === 200) {
            if ($response->bodyReadFailure !== null) {
                throw new ResponseDecodeException('response body could not be read', $response->body, $attempts, $response->bodyReadFailure);
            }
            if ($response->bodyTruncated) {
                throw new ResponseDecodeException('response body exceeds 65536 bytes', $response->body, $attempts);
            }

            return self::acknowledgement($response->body, $attempts);
        }

        [$message, $code] = self::errorEnvelope($response->body) ?? [self::fallbackMessage($response), null];

        return match ($response->status) {
            401 => throw new AuthenticationException($message, 401, $code, $response->body, $attempts),
            404 => throw new EventDefinitionNotFoundException($message, 404, $code, $response->body, $attempts),
            default => throw new ApiException($message, $response->status, $code, $response->body, $attempts),
        };
    }

    private static function acknowledgement(string $body, int $attempts): Acknowledgement
    {
        try {
            $envelope = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new ResponseDecodeException('response body is not valid JSON', $body, $attempts, $error);
        }
        $data = $envelope instanceof \stdClass ? ($envelope->data ?? null) : null;
        $valid = $envelope instanceof \stdClass
            && ($envelope->success ?? null) === true
            && $data instanceof \stdClass
            && ($data->success ?? null) === true
            && is_string($data->message ?? null) && $data->message !== ''
            && is_string($data->event_key ?? null) && $data->event_key !== ''
            && is_array($data->validated_properties ?? null)
            && array_is_list($data->validated_properties)
            && array_filter($data->validated_properties, 'is_string') === $data->validated_properties;
        if (!$valid) {
            throw new ResponseDecodeException('response body is not a valid success envelope', $body, $attempts);
        }

        /** @var list<string> $validatedProperties */
        $validatedProperties = $data->validated_properties;

        return new Acknowledgement(true, $data->message, $data->event_key, $validatedProperties, $body);
    }

    /**
     * @return array{string, ?string}|null
     */
    private static function errorEnvelope(string $body): ?array
    {
        try {
            $envelope = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
        if (!$envelope instanceof \stdClass || ($envelope->success ?? null) !== false || !is_string($envelope->error ?? null) || $envelope->error === '') {
            return null;
        }
        if (!property_exists($envelope, 'code')) {
            return [$envelope->error, null];
        }

        return is_string($envelope->code) ? [$envelope->error, $envelope->code] : null;
    }

    private static function fallbackMessage(TransportResponse $response): string
    {
        $reason = trim($response->reasonPhrase);

        return $reason !== '' ? $reason : HttpStatusText::forStatus($response->status);
    }
}
