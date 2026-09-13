<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

/**
 * @internal
 */
final class SystemSleeper implements Sleeper
{
    public function sleepMilliseconds(int $milliseconds): void
    {
        if ($milliseconds > 0) {
            usleep($milliseconds * 1000);
        }
    }
}
