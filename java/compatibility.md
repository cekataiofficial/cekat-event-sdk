# Java SDK compatibility evidence

Verified on: 2026-09-13 (UTC).

## Coordinates

- Maven group: `ai.cekat`; package prefix `ai.cekat.events`; repository path prefix `ai/cekat/`.
- Artifacts: `cekat-event-sdk-core`, `cekat-event-sdk-jakarta-servlet`, `cekat-event-sdk-spring-boot` (parent `cekat-event-sdk-parent`); `cekat-event-sdk-conformance-tests` is never published.
- **Release gate (open):** Central Portal verification that Cekat controls the `ai.cekat` namespace (DNS TXT on `cekat.ai`) must be completed by the release owner before publication. No namespace-verification export was available during implementation.

## Official sources

- Java runtime lifecycle: <https://endoflife.date/api/v1/products/eclipse-temurin/> and <https://adoptium.net/support/>
- Spring Boot support: <https://endoflife.date/api/v1/products/spring-boot/> and <https://github.com/spring-projects/spring-boot/wiki/Supported-Versions>
- Maven: <https://endoflife.date/api/v1/products/maven/>
- Artifact versions: `https://repo.maven.apache.org/maven2/<group>/<artifact>/maven-metadata.xml`

## Runtime

Java bytecode floor: 17

| JDK line | Type | Temurin support | Observed |
| --- | --- | --- | --- |
| 25 | LTS | until 2031-09-30 | 25.0.4 |
| 21 | LTS | until 2029-12-31 | 21.0.12 |
| 17 | LTS | maintained | 17.0.20 |
| 26 | short-term | ends 2026-09-15 | excluded |

Spring Boot 4 and JUnit 6 both require Java 17, matching the SDK floor. All production classes compile with `--release 17` (class major version 61, verified with `javap`). `jdeps` resolves the core jar to `java.base` and `java.net.http` only.

## Frameworks

| Component | Supported | Evidence |
| --- | --- | --- |
| Spring Boot | 4.0, 4.1 | 4.1.1 (OSS support until 2027-07-31); 4.0.8 (OSS support until 2026-12-31). 3.5 open-source support ended 2026-06-30. Boot 4 uses Jackson 3, Jakarta Servlet 6.1, and Tomcat 11. The auto-configuration uses `org.springframework.boot.web.servlet.FilterRegistrationBean` and `org.springframework.boot.autoconfigure.*`, present in both lines. |
| Jakarta Servlet API | 6.0+ (compiled against 6.0.0, `provided`) | Latest stable 6.1.0; the filter uses only Servlet 6.0 APIs. |
| Embedded test container | Tomcat 11.0.25 | Async, error, and concurrent dispatch tests run on a real container. |

## Build and test tooling (exact pins)

Maven Wrapper distribution: 3.9.16 (wrapper 3.3.4, `only-script`)

maven-compiler-plugin 3.16.0 (`-Xlint:all,-processing,-options,-try -Werror`), maven-surefire-plugin 3.6.0, maven-enforcer-plugin 3.6.3, maven-jar-plugin 3.5.1, maven-source-plugin 3.4.0, maven-javadoc-plugin 3.12.0, maven-checkstyle-plugin 3.6.0 with Checkstyle 14.1.0, spotbugs-maven-plugin 4.10.4.1, jacoco-maven-plugin 0.8.15 (core line coverage ≥ 85%), JUnit 6.1.3. Conformance tests only: jackson-databind 3.2.2, json-schema-validator 3.0.7.

Checkstyle 11+ requires a Java 21 runtime, so Checkstyle and SpotBugs run automatically on JDK 21 and newer (Maven profile `static-analysis`).

## Execution matrix (2026-09-13)

| JDK | Spring Boot | Unit and integration tests | Static analysis | Shared conformance |
| --- | --- | --- | --- | --- |
| 17.0.20 | 4.1.1 and 4.0.8 | core 79, servlet 5, Spring 7 passed | not run (requires JDK 21+) | 57 passed |
| 25.0.4 | 4.1.1 | core 79, servlet 5, Spring 7 passed | Checkstyle 0 violations, SpotBugs 0 bugs | 57 passed |

`scripts/package --version 0.1.0` passed on JDK 25; every jar, sources jar, Javadoc jar, and POM resolved from the produced file repository with `mvn dependency:get`, including `cekat-event-sdk-spring-boot` with its transitive SDK modules, and no test classes were packaged.
