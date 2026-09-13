<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\AuthenticationException;
use Cekat\EventSdk\Exception\EventDefinitionNotFoundException;
use Cekat\EventSdk\Exception\ResponseDecodeException;
use Cekat\EventSdk\Internal\ResponseDecoder;
use Cekat\EventSdk\Transport\TransportResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ResponseDecoderTest extends TestCase
{
    private const SUCCESS = '{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"],"extra":1}}';

    public function testDecodesStrictSuccessEnvelope(): void
    {
        $ack = ResponseDecoder::decode(new TransportResponse(200, [], self::SUCCESS, 'OK'), 2);
        self::assertTrue($ack->success);
        self::assertSame('accepted', $ack->message);
        self::assertSame('order_paid', $ack->eventKey);
        self::assertSame(['order_id'], $ack->validatedProperties);
        self::assertSame(self::SUCCESS, $ack->rawBody);
    }

    /** @return iterable<string, array{string}> */
    public static function malformedSuccess(): iterable
    {
        yield 'invalid json' => ['{not-json'];
        yield 'outer false' => ['{"success":false,"data":{"success":true,"message":"a","event_key":"k","validated_properties":[]}}'];
        yield 'data list' => ['{"success":true,"data":[]}'];
        yield 'inner missing' => ['{"success":true,"data":{"message":"a","event_key":"k","validated_properties":[]}}'];
        yield 'blank message' => ['{"success":true,"data":{"success":true,"message":"","event_key":"k","validated_properties":[]}}'];
        yield 'blank key' => ['{"success":true,"data":{"success":true,"message":"a","event_key":"","validated_properties":[]}}'];
        yield 'properties object' => ['{"success":true,"data":{"success":true,"message":"a","event_key":"k","validated_properties":{}}}'];
        yield 'property non-string' => ['{"success":true,"data":{"success":true,"message":"a","event_key":"k","validated_properties":[1]}}'];
    }

    #[DataProvider('malformedSuccess')]
    public function testMalformedSuccessIsDecodeError(string $body): void
    {
        try {
            ResponseDecoder::decode(new TransportResponse(200, [], $body, 'OK'), 1);
            self::fail('Expected ResponseDecodeException');
        } catch (ResponseDecodeException $error) {
            self::assertSame($body, $error->rawBody);
            self::assertSame(200, $error->statusCode);
            self::assertSame(1, $error->attempts);
            self::assertFalse($error->deliveryOutcomeUnknown);
        }
    }

    public function testTruncatedOrUnreadableSuccessIsDecodeError(): void
    {
        $this->expectDecode(new TransportResponse(200, [], str_repeat('a', 65536), 'OK', true, 65537), 'exceeds 65536 bytes');
        $this->expectDecode(new TransportResponse(200, [], '{"success":tr', 'OK', false, 13, new \RuntimeException('reset')), 'could not be read');
    }

    public function testMapsStructuredErrorsToTypedExceptions(): void
    {
        $body = '{"success":false,"error":"defined server error","code":"fixture_code"}';
        foreach ([400 => ApiException::class, 401 => AuthenticationException::class, 404 => EventDefinitionNotFoundException::class, 422 => ApiException::class] as $status => $type) {
            $error = $this->expectApi(new TransportResponse($status, [], $body, 'Fallback'));
            self::assertSame($type, $error::class);
            self::assertSame('defined server error', $error->getMessage());
            self::assertSame('fixture_code', $error->serverCode);
            self::assertSame($status, $error->statusCode);
            self::assertSame($body, $error->rawBody);
            self::assertFalse($error->deliveryOutcomeUnknown);
        }
        self::assertNull($this->expectApi(new TransportResponse(400, [], '{"success":false,"error":"no code"}', ''))->serverCode);
    }

    public function testMalformedErrorsUseReasonPhraseThenStatusText(): void
    {
        self::assertSame('Custom Reason', $this->expectApi(new TransportResponse(418, [], 'not json', ' Custom Reason '))->getMessage());
        self::assertSame("I'm a teapot", $this->expectApi(new TransportResponse(418, [], '{"success":false,"error":""}', ''))->getMessage());
        self::assertSame('Gateway Timeout', $this->expectApi(new TransportResponse(504, [], '{"success":false,"error":"x","code":null}', ''))->getMessage());
        self::assertSame('HTTP 599', $this->expectApi(new TransportResponse(599, [], '', ''))->getMessage());
        self::assertSame('Bad Gateway', $this->expectApi(new TransportResponse(502, [], '', '', false, 0, new \RuntimeException('reset')))->getMessage());
    }

    private function expectApi(TransportResponse $response): ApiException
    {
        try {
            ResponseDecoder::decode($response, 1);
        } catch (ApiException $error) {
            return $error;
        }
        self::fail('Expected ApiException');
    }

    private function expectDecode(TransportResponse $response, string $message): void
    {
        try {
            ResponseDecoder::decode($response, 1);
            self::fail('Expected ResponseDecodeException');
        } catch (ResponseDecodeException $error) {
            self::assertStringContainsString($message, $error->getMessage());
        }
    }
}
