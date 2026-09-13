package ai.cekat.events.spring;

import ai.cekat.events.CekatClientOptions;
import java.net.URI;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Configuration under the {@code cekat} prefix. */
@ConfigurationProperties("cekat")
public class CekatEventSdkProperties {
    /** Access token. The client bean is created only when this property is set. */
    private String accessToken;
    /** Absolute HTTP(S) origin; the SDK always posts to /api/events/ingest. */
    private URI baseUrl = CekatClientOptions.DEFAULT_BASE_URL;
    /** Timeout for each network attempt. */
    private Duration timeout = CekatClientOptions.DEFAULT_TIMEOUT;
    /** Retries after the initial attempt. */
    private int retryCount = CekatClientOptions.DEFAULT_RETRY_COUNT;
    /** Whether to register the visitor filter. */
    private boolean visitorFilterEnabled = true;

    /**
     * Returns the access token.
     *
     * @return access token
     */
    public String getAccessToken() {
        return accessToken;
    }

    /**
     * Sets the access token.
     *
     * @param accessToken access token
     */
    public void setAccessToken(String accessToken) {
        this.accessToken = accessToken;
    }

    /**
     * Returns the origin.
     *
     * @return origin
     */
    public URI getBaseUrl() {
        return baseUrl;
    }

    /**
     * Sets the origin.
     *
     * @param baseUrl origin
     */
    public void setBaseUrl(URI baseUrl) {
        this.baseUrl = baseUrl;
    }

    /**
     * Returns the per-attempt timeout.
     *
     * @return timeout
     */
    public Duration getTimeout() {
        return timeout;
    }

    /**
     * Sets the per-attempt timeout.
     *
     * @param timeout timeout
     */
    public void setTimeout(Duration timeout) {
        this.timeout = timeout;
    }

    /**
     * Returns the retry count.
     *
     * @return retry count
     */
    public int getRetryCount() {
        return retryCount;
    }

    /**
     * Sets the retry count.
     *
     * @param retryCount retry count
     */
    public void setRetryCount(int retryCount) {
        this.retryCount = retryCount;
    }

    /**
     * Returns whether the visitor filter is registered.
     *
     * @return {@code true} by default
     */
    public boolean isVisitorFilterEnabled() {
        return visitorFilterEnabled;
    }

    /**
     * Sets whether the visitor filter is registered.
     *
     * @param visitorFilterEnabled flag
     */
    public void setVisitorFilterEnabled(boolean visitorFilterEnabled) {
        this.visitorFilterEnabled = visitorFilterEnabled;
    }

    @Override
    public String toString() {
        return "CekatEventSdkProperties[baseUrl=" + baseUrl + ", timeout=" + timeout + ", retryCount=" + retryCount + "]";
    }
}
