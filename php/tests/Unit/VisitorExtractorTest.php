<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\Context\VisitorExtractor;
use GuzzleHttp\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;

final class VisitorExtractorTest extends TestCase
{
    public function testHeaderWinsOverCookieAndValuesAreTrimmed(): void
    {
        self::assertSame('header', VisitorExtractor::fromNormalized(['x-cekat-visitor-id' => ' header ', 'Cookie' => '_cekat_visitor_id=cookie']));
        self::assertSame('cookie', VisitorExtractor::fromNormalized(['X-CEKAT-VISITOR-ID' => [" \t", ''], 'cookie' => 'other=1; _cekat_visitor_id= cookie ']));
        self::assertSame('second', VisitorExtractor::fromNormalized(['X-Cekat-Visitor-ID' => [' ', 'second']]));
        self::assertNull(VisitorExtractor::fromNormalized(['X-Cekat-Visitor-ID' => ' ', 'Cookie' => '_cekat_visitor_id= ']));
        self::assertNull(VisitorExtractor::fromNormalized([]));
    }

    public function testRawCookieHeaderIsPreferredOverParsedCookies(): void
    {
        self::assertSame('raw', VisitorExtractor::fromNormalized(['Cookie' => '_cekat_visitor_id=raw'], ['_cekat_visitor_id' => 'parsed']));
        self::assertSame('parsed', VisitorExtractor::fromNormalized([], ['_cekat_visitor_id' => ' parsed ']));
        self::assertSame('a%20b', VisitorExtractor::fromCookieHeader('x_cekat_visitor_id=nope; _cekat_visitor_id=a%20b'));
        self::assertNull(VisitorExtractor::fromCookieHeader('malformed; other=value'));
    }

    public function testPsrRequest(): void
    {
        $request = (new ServerRequest('GET', '/'))->withHeader('Cookie', '_cekat_visitor_id=cookie-visitor');
        self::assertSame('cookie-visitor', VisitorExtractor::fromPsrRequest($request));
        self::assertSame('header-visitor', VisitorExtractor::fromPsrRequest($request->withHeader('x-cekat-visitor-id', 'header-visitor')));
        self::assertSame('parsed', VisitorExtractor::fromPsrRequest((new ServerRequest('GET', '/'))->withCookieParams(['_cekat_visitor_id' => 'parsed'])));
    }
}
