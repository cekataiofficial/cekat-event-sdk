package ai.cekat.events;

import ai.cekat.events.error.ValidationException;
import ai.cekat.events.transport.HttpTransport;
import ai.cekat.events.transport.JdkHttpTransport;
import java.net.URI;
import java.time.Duration;
import java.util.Locale;
import java.util.Objects;
import java.util.function.LongUnaryOperator;

/** Optional client configuration. Invalid values throw {@link ValidationException} from {@link Builder#build()}. */
public final class CekatClientOptions {
    /** Production origin. */
    public static final URI DEFAULT_BASE_URL = URI.create("https://t.cekat.ai");
    /** Default per-attempt timeout. */
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(3);
    /** Default retries after the initial attempt. */
    public static final int DEFAULT_RETRY_COUNT = 2;

    private final URI baseUrl;
    private final Duration timeout;
    private final int retryCount;
    private final HttpTransport transport;
    private final Sleeper sleeper;
    private final LongUnaryOperator jitter;

    private CekatClientOptions(Builder builder) {
        this.baseUrl = normalizeOrigin(builder.baseUrl);
        if (builder.timeout == null || builder.timeout.isNegative() || builder.timeout.isZero()) {
            throw new ValidationException("timeout must be greater than zero");
        }
        if (builder.retryCount < 0 || builder.retryCount == Integer.MAX_VALUE) {
            throw new ValidationException("retry count must be a nonnegative int less than Integer.MAX_VALUE");
        }
        this.timeout = builder.timeout;
        this.retryCount = builder.retryCount;
        this.transport = Objects.requireNonNullElseGet(builder.transport, JdkHttpTransport::new);
        this.sleeper = Objects.requireNonNullElse(builder.sleeper, duration -> Thread.sleep(duration.toMillis()));
        this.jitter = Objects.requireNonNullElse(builder.jitter,
                bound -> java.util.concurrent.ThreadLocalRandom.current().nextLong(bound + 1));
    }

    /**
     * Returns the default options.
     *
     * @return defaults
     */
    public static CekatClientOptions defaults() {
        return builder().build();
    }

    /**
     * Starts building options.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Returns the normalized origin.
     *
     * @return origin without a trailing slash
     */
    public URI baseUrl() {
        return baseUrl;
    }

    /**
     * Returns the fixed ingest URI.
     *
     * @return {@code <baseUrl>/api/events/ingest}
     */
    public URI ingestUri() {
        return URI.create(baseUrl + "/api/events/ingest");
    }

    /**
     * Returns the per-attempt timeout.
     *
     * @return timeout
     */
    public Duration timeout() {
        return timeout;
    }

    /**
     * Returns the retries after the initial attempt.
     *
     * @return retry count
     */
    public int retryCount() {
        return retryCount;
    }

    HttpTransport transport() {
        return transport;
    }

    Sleeper sleeper() {
        return sleeper;
    }

    LongUnaryOperator jitter() {
        return jitter;
    }

    private static URI normalizeOrigin(URI uri) {
        ValidationException invalid = new ValidationException(
                "base URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
        if (uri == null || !uri.isAbsolute() || uri.isOpaque() || uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) {
            throw invalid;
        }
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw invalid;
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return URI.create(scheme + "://" + host + (uri.getPort() == -1 ? "" : ":" + uri.getPort()));
    }

    /** Delays between retries; replaceable for tests. */
    @FunctionalInterface
    public interface Sleeper {
        /**
         * Sleeps for a duration.
         *
         * @param duration delay
         * @throws InterruptedException when interrupted
         */
        void sleep(Duration duration) throws InterruptedException;
    }

    /** Builds {@link CekatClientOptions}. */
    public static final class Builder {
        private URI baseUrl = DEFAULT_BASE_URL;
        private Duration timeout = DEFAULT_TIMEOUT;
        private int retryCount = DEFAULT_RETRY_COUNT;
        private HttpTransport transport;
        private Sleeper sleeper;
        private LongUnaryOperator jitter;

        private Builder() {
        }

        /**
         * Sets the origin; the SDK always posts to {@code /api/events/ingest}.
         *
         * @param value absolute HTTP(S) origin
         * @return this builder
         */
        public Builder baseUrl(URI value) {
            this.baseUrl = value;
            return this;
        }

        /**
         * Sets the origin from a string.
         *
         * @param value absolute HTTP(S) origin
         * @return this builder
         */
        public Builder baseUrl(String value) {
            try {
                this.baseUrl = value == null ? null : new URI(value);
            } catch (java.net.URISyntaxException invalid) {
                this.baseUrl = null;
            }
            return this;
        }

        /**
         * Sets the per-attempt timeout.
         *
         * @param value timeout greater than zero
         * @return this builder
         */
        public Builder timeout(Duration value) {
            this.timeout = value;
            return this;
        }

        /**
         * Sets the retries after the initial attempt.
         *
         * @param value nonnegative retry count
         * @return this builder
         */
        public Builder retryCount(int value) {
            this.retryCount = value;
            return this;
        }

        /**
         * Replaces the HTTP transport.
         *
         * @param value transport
         * @return this builder
         */
        public Builder transport(HttpTransport value) {
            this.transport = value;
            return this;
        }

        /**
         * Replaces the retry sleeper; intended for tests.
         *
         * @param value sleeper
         * @return this builder
         */
        public Builder sleeper(Sleeper value) {
            this.sleeper = value;
            return this;
        }

        /**
         * Replaces the jitter source, which maps an inclusive upper bound in milliseconds to a delay; intended for tests.
         *
         * @param value jitter source
         * @return this builder
         */
        public Builder jitter(LongUnaryOperator value) {
            this.jitter = value;
            return this;
        }

        /**
         * Validates and builds the options.
         *
         * @return options
         */
        public CekatClientOptions build() {
            return new CekatClientOptions(this);
        }
    }
}
