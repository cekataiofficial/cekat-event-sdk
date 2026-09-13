# PHP SDK compatibility evidence

Retrieved: 2026-09-13 (UTC).

## Official sources

- PHP supported versions: <https://www.php.net/supported-versions.php>, <https://www.php.net/releases/active.php>, and <https://endoflife.date/api/v1/products/php/>
- Composer package metadata: `composer show --all --format=json <package> [<version>]` against Packagist (Composer 2.10.3)
- Composer security advisories: Packagist advisory database, enforced by Composer's default `policy.advisories.block`

## PHP runtime

| Line | Active support until | Security support until | Observed patch |
| --- | --- | --- | --- |
| 8.2 | 2024-12-31 | 2026-12-31 | 8.2.33 |
| 8.3 | 2025-12-31 | 2027-12-31 | 8.3.33 |
| 8.4 | 2026-12-31 | 2028-12-31 | 8.4.25 |
| 8.5 | 2027-12-31 | 2029-12-31 | 8.5.10 |

The package floor is **PHP 8.2** (`"php": "^8.2"`). PHP 8.2 is still security-maintained and is the floor required by Laravel 12, but it reaches end of life on **2026-12-31**. Raise the floor to 8.3 in the first release after that date.

## Selected dependency ranges

| Package | Declared range | Evidence |
| --- | --- | --- |
| guzzlehttp/guzzle (runtime) | `^7.15.2 \|\| ^8.0` | Latest 8.2.0 (PHP `^7.4 \|\| ^8.0`) and 7.15.5. Laravel 12 requires `^7.8.2`; Laravel 13 allows `^7.8.2 \|\| ^8.0`. Composer refuses Guzzle 7.8.x through 7.15.1 under default advisory blocking, so 7.15.2 is the lowest installable Guzzle 7. |
| psr/http-message | `^1.1 \|\| ^2.0` | Matches Guzzle 7 and 8; 1.1 adds the parameter types `BoundedSinkStream` implements. |
| psr/http-client, psr/http-factory, psr/http-server-handler, psr/http-server-middleware | `^1.0` | Stable interface packages. |
| laravel/framework (optional integration) | 12, 13 | 13.31.0 requires PHP `^8.3`; 12.69.2 requires PHP `^8.2`. Laravel 11 is outside security support. |
| symfony/http-kernel (optional integration) | 6.4, 7.4, 8 | 8.1.6 requires PHP `>=8.4.1`; 7.4.18 requires `>=8.2`; 6.4.45 requires `>=8.1`. |
| orchestra/testbench (dev) | `^10.0 \|\| ^11.0` | 11.2.0 (Laravel 13, PHP `^8.3`); 10.11.0 (Laravel 12, PHP `^8.2`). |
| phpunit/phpunit (dev) | `^11.5 \|\| ^12.5 \|\| ^13.0` | 13.3.3 requires PHP `>=8.4.1`; 12.5.35 `>=8.3`; 11.5.56 `>=8.2`. |
| phpstan/phpstan (dev) | `^2.1` | 2.2.14. |
| friendsofphp/php-cs-fixer (dev) | `^3.64` | 3.95.25. |
| opis/json-schema (dev) | `^2.4` | Draft 2020-12 validation of the shared conformance schemas. |

## Execution matrix (2026-09-13)

Every row ran the unit suite (unit, transport, PSR-15, Laravel, Symfony, long-worker, and packaging tests) and the shared conformance suite against `conformance/mock-ingest-server`: 54 cases passed and the 3 caller-cancellation cases were reported `not_applicable`.

| PHP | Resolution | Guzzle | Laravel | Symfony | PHPUnit | Unit tests |
| --- | --- | --- | --- | --- | --- | --- |
| 8.2.33 | `--prefer-lowest --prefer-stable` | 7.15.2 | 12.61.1 | 7.4.12 | 11.5.50 | 75 passed |
| 8.2.33 | highest | 7.15.5 | 12.69.2 | 7.4.18 | 11.5.56 | 75 passed |
| 8.5.10 | `--prefer-lowest --prefer-stable` | 7.15.2 | 12.61.1 | 7.4.12 | 11.5.50 | 75 passed |
| 8.5.10 | highest | 8.2.0 | 13.31.0 | 8.1.6 | 13.3.3 | 75 passed |
| 8.2.33 | lowest, Laravel removed, Symfony `~6.4.0` | 7.15.2 | — | 6.4.0 (http-foundation 6.4.41) | 11.5.50 | 72 passed (Laravel test excluded) |

PHPStan level 8 and PHP-CS-Fixer (`@PER-CS2.0`) pass on PHP 8.5. `composer audit` reports no advisories for the highest resolution.
