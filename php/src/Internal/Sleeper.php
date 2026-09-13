<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Internal;

/**
 * @internal
 */
interface Sleeper
{
    public function sleepMilliseconds(int $milliseconds): void;
}
