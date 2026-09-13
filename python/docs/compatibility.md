# Python SDK compatibility evidence

Retrieved: 2026-09-13 (UTC). Machine-readable PyPI observations: [compatibility-evidence.json](compatibility-evidence.json), regenerated with `scripts/verify-compatibility`.

## Official sources

- CPython lifecycle: <https://devguide.python.org/versions/>
- Django supported versions: <https://www.djangoproject.com/download/#supported-versions>
- Flask changes and support: <https://flask.palletsprojects.com/en/stable/changes/>
- Package metadata: `https://pypi.org/pypi/<package>/json`
- Security advisories: `pip-audit` (PyPI advisory database and OSV), run by `scripts/package`

## CPython

| Line | Status | End of life | Observed patch |
| --- | --- | --- | --- |
| 3.14 | bugfix | 2030-10 | 3.14.7 |
| 3.13 | bugfix | 2029-10 | 3.13.15 |
| 3.12 | security | 2028-10 | 3.12.14 |
| 3.11 | security | 2027-10 | 3.11.16 |
| 3.10 | security | **2026-10** | 3.10.21 |

`requires-python` is `>=3.10`, the oldest maintained line. Python 3.10 reaches end of life in October 2026; the floor stays until a release after that date, when it moves to 3.11. Nothing in the SDK needs a newer interpreter.

## Runtime dependencies

| Package | Range | Evidence |
| --- | --- | --- |
| httpx | `>=0.27,<1` | 0.28.1 latest (requires Python >= 3.8). 0.27.0 is the tested floor. |
| anyio | `>=4.5,<5` | 4.15.1 latest (requires Python >= 3.10). Already required by httpx; the async client uses it for per-attempt deadlines and cancellable sleeps, so it works under asyncio and Trio. 4.5.0 is the tested floor. |

## Framework extras

| Extra | Range | Evidence |
| --- | --- | --- |
| `django` | `Django>=5.2,<7` | 6.1.1 (requires Python >= 3.12, supported until 2027-12); 6.0.8 (until 2027-04); 5.2.17 LTS (until 2028-04, Python 3.10+). Django 5.2 is the only maintained line for Python 3.10 and 3.11. |
| `flask` | `Flask>=3.1,<4` | 3.1.3 latest (requires Python >= 3.9). Flask supports its latest feature release. |
| `asgi` | `starlette>=0.41,<2` | 1.6.0 latest (requires Python >= 3.10). The middleware uses only the ASGI 3 interface, so any ASGI server or framework works. |
| `fastapi` | `fastapi>=0.115.3,<1` | 0.141.1 latest (requires Python >= 3.10). 0.115.3 is the first release accepting Starlette 0.41. |

The integrations import their framework only when you import `cekat_event_sdk.integrations.<name>`; the core package never imports Django, Flask, or Starlette. The extras' floors are compatibility floors, not security recommendations: keep frameworks on their latest patch release.

## Development tooling (latest observed)

pytest 9.1.1, pytest-asyncio 1.4.0, mypy 2.3.1, ruff 0.16.7, jsonschema 4.26.0, hatchling 1.32.0, build 1.6.1, twine 7.0.0, pip-audit 2.10.1, asgiref 3.12.1.

## Execution matrix (2026-09-13)

Every row ran the unit, integration (Django, Flask, Starlette, FastAPI), and packaging tests, and the shared conformance suite against `conformance/mock-ingest-server`: all 57 cases passed. The runner executes each non-cancellation case through both `Client` and `AsyncClient`, and the three caller-cancellation cases through `AsyncClient`.

| Python | Profile | httpx | anyio | Django | Flask | Starlette | FastAPI | pytest / pytest-asyncio | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3.10.21 (Docker) | lowest (`constraints-lowest.txt`) | 0.27.0 | 4.5.0 | 5.2 | 3.1.0 | 0.41.0 | 0.115.3 | 8.3.0 / 0.24.0 | 160 passed |
| 3.12.13 (macOS) | highest | 0.28.1 | 4.15.1 | 6.1.1 | 3.1.3 | 1.6.0 | 0.141.1 | 9.1.1 / 1.4.0 | 160 passed |
| 3.14.7 (Docker) | highest | 0.28.1 | 4.15.1 | 6.1.1 | 3.1.3 | 1.6.0 | 0.141.1 | 9.1.1 / 1.4.0 | 160 passed, mypy and Ruff clean |

`scripts/package` passed on Python 3.12.13: tests, Ruff, mypy, `pip-audit` (no known vulnerabilities), wheel and sdist build, and `twine check --strict`.

## Release checklist

1. Run `scripts/verify-compatibility > docs/compatibility-evidence.json` and compare it with the official lifecycle pages above.
2. If a supported line reached end of life or a new major release appeared, update the ranges, `constraints-lowest.txt`, the CI matrix, and this document together.
3. Run the lowest and highest CI profiles and `scripts/package`.
