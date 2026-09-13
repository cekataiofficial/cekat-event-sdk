package ai.cekat.events.spring;

import ai.cekat.events.CekatClient;
import ai.cekat.events.CekatClientOptions;
import ai.cekat.events.servlet.CekatVisitorFilter;
import jakarta.servlet.DispatcherType;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

/**
 * Creates a {@link CekatClient} when {@code cekat.access-token} is set, and registers {@link CekatVisitorFilter} in
 * servlet web applications for the REQUEST, ASYNC, and ERROR dispatcher types.
 */
@AutoConfiguration
@EnableConfigurationProperties(CekatEventSdkProperties.class)
public class CekatEventSdkAutoConfiguration {
    /** Filter order: early, before application filters, without assuming authentication semantics. */
    public static final int FILTER_ORDER = Ordered.HIGHEST_PRECEDENCE + 100;

    /**
     * Creates the client.
     *
     * @param properties bound properties
     * @return client
     */
    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnProperty(prefix = "cekat", name = "access-token")
    public CekatClient cekatClient(CekatEventSdkProperties properties) {
        return new CekatClient(properties.getAccessToken(), CekatClientOptions.builder()
                .baseUrl(properties.getBaseUrl())
                .timeout(properties.getTimeout())
                .retryCount(properties.getRetryCount())
                .build());
    }

    /** Servlet filter registration. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    @ConditionalOnClass(jakarta.servlet.Filter.class)
    @ConditionalOnBooleanProperty(name = "cekat.visitor-filter-enabled", matchIfMissing = true)
    static class VisitorFilterConfiguration {
        @Bean
        @ConditionalOnMissingBean(name = "cekatVisitorFilterRegistration")
        FilterRegistrationBean<CekatVisitorFilter> cekatVisitorFilterRegistration() {
            FilterRegistrationBean<CekatVisitorFilter> registration = new FilterRegistrationBean<>(new CekatVisitorFilter());
            registration.setName("cekatVisitorFilter");
            registration.setAsyncSupported(true);
            registration.setDispatcherTypes(DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR);
            registration.addUrlPatterns("/*");
            registration.setOrder(FILTER_ORDER);
            return registration;
        }
    }
}
