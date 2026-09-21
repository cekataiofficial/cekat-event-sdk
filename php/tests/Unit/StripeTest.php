<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Unit;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Stripe;
use PHPUnit\Framework\TestCase;

final class StripeTest extends TestCase
{
    public function testMetadataForVisitorValidatesAndTrims(): void
    {
        self::assertSame(['cekat_visitor_id' => 'visitor_A-1'], Stripe::metadataForVisitor(' visitor_A-1 '));
        self::assertSame(['cekat_visitor_id' => 'a'], Stripe::metadataForVisitor('a'));
        self::assertSame(['cekat_visitor_id' => str_repeat('a', 128)], Stripe::metadataForVisitor(str_repeat('a', 128)));
        self::assertSame([], Stripe::metadataForVisitor(str_repeat('a', 129)));
        self::assertSame([], Stripe::metadataForVisitor('invalid visitor'));
    }

    public function testContextAndMergeMetadataAreNonMutating(): void
    {
        $context = new VisitorContext();
        self::assertSame(['cekat_visitor_id' => 'scoped'], $context->runWithVisitorId(' scoped ', static fn(): array => Stripe::metadataFromContext($context)));
        self::assertSame([], Stripe::metadataFromContext($context));

        $merchant = ['merchant' => 'keep', 'cekat_visitor_id' => 'replace'];
        self::assertSame(['merchant' => 'keep', 'cekat_visitor_id' => 'visitor_2'], Stripe::mergeMetadata($merchant, ' visitor_2 '));
        self::assertSame(['merchant' => 'keep', 'cekat_visitor_id' => 'replace'], $merchant);
        self::assertSame($merchant, Stripe::mergeMetadata($merchant, 'invalid visitor'));
    }
}
