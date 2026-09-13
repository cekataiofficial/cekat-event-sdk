<?php

declare(strict_types=1);

namespace Cekat\EventSdk\Tests\Support;

use Cekat\EventSdk\Internal\Sleeper;

final class RecordingSleeper implements Sleeper
{
    /** @var list<int> */
    public array $sleeps = [];

    public function sleepMilliseconds(int $milliseconds): void
    {
        $this->sleeps[] = $milliseconds;
    }
}
