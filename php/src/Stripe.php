<?php

declare(strict_types=1);

namespace Cekat\EventSdk;

use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorContextInterface;

final class Stripe
{
    private const VISITOR_METADATA_KEY = 'cekat_visitor_id';

    /** @return array<string, string> */
    public static function metadataForVisitor(mixed $visitorId): array
    {
        $normalized = self::validVisitorId($visitorId);

        return $normalized === null ? [] : [self::VISITOR_METADATA_KEY => $normalized];
    }

    /** @return array<string, string> */
    public static function metadataFromContext(?VisitorContextInterface $context = null): array
    {
        return self::metadataForVisitor(($context ?? VisitorContext::shared())->current());
    }

    /** @param array<string, string> $metadata
     *  @return array<string, string>
     */
    public static function mergeMetadata(array $metadata, mixed $visitorId): array
    {
        $merged = $metadata;
        $normalized = self::validVisitorId($visitorId);
        if ($normalized !== null) {
            $merged[self::VISITOR_METADATA_KEY] = $normalized;
        }

        return $merged;
    }

    private static function validVisitorId(mixed $visitorId): ?string
    {
        if (!is_string($visitorId)) {
            return null;
        }
        $normalized = trim($visitorId);
        if ($normalized === '' || strlen($normalized) > 128 || preg_match('/^[A-Za-z0-9_-]+$/', $normalized) !== 1) {
            return null;
        }

        return $normalized;
    }
}
