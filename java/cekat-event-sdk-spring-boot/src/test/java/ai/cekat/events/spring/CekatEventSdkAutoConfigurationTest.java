package ai.cekat.events.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.CekatClient;
import ai.cekat.events.error.ValidationException;
import ai.cekat.events.servlet.CekatVisitorFilter;
import jakarta.servlet.DispatcherType;
import java.util.EnumSet;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

class CekatEventSdkAutoConfigurationTest {
    private final WebApplicationContextRunner web = new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(CekatEventSdkAutoConfiguration.class));

    @Test
    void createsClientFromPropertiesAndRegistersFilter() {
        web.withPropertyValues("cekat.access-token=secret-token", "cekat.base-url=https://ingest.example.test/",
                "cekat.timeout=1500ms", "cekat.retry-count=4").run(context -> {
                    CekatClient client = context.getBean(CekatClient.class);
                    assertEquals("CekatClient[baseUrl=https://ingest.example.test, timeout=PT1.5S, retryCount=4]", client.toString());
                    FilterRegistrationBean<?> registration = context.getBean("cekatVisitorFilterRegistration", FilterRegistrationBean.class);
                    assertTrue(registration.getFilter() instanceof CekatVisitorFilter);
                    assertTrue(registration.isAsyncSupported());
                    assertEquals(CekatEventSdkAutoConfiguration.FILTER_ORDER, registration.getOrder());
                    assertEquals(Set.of("/*"), Set.copyOf(registration.getUrlPatterns()));
                    assertEquals(EnumSet.of(DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR),
                            registration.determineDispatcherTypes());
                    assertFalse(context.getBean(CekatEventSdkProperties.class).toString().contains("secret-token"));
                });
    }

    @Test
    void skipsClientWithoutTokenButKeepsFilter() {
        web.run(context -> {
            assertTrue(context.getBeansOfType(CekatClient.class).isEmpty());
            assertNotNull(context.getBean("cekatVisitorFilterRegistration"));
        });
    }

    @Test
    void blankTokenFailsStartupWithoutEchoingIt() {
        web.withPropertyValues("cekat.access-token= ").run(context -> {
            Throwable failure = context.getStartupFailure();
            assertNotNull(failure);
            Throwable root = failure;
            while (root.getCause() != null) {
                root = root.getCause();
            }
            assertTrue(root instanceof ValidationException, root.toString());
            assertTrue(root.getMessage().contains("access token"));
        });
    }

    @Test
    void backsOffForUserClientAndHonorsFilterSwitch() {
        web.withUserConfiguration(UserClient.class).withPropertyValues("cekat.access-token=ignored").run(context ->
                assertSame(UserClient.CLIENT, context.getBean(CekatClient.class)));
        web.withPropertyValues("cekat.visitor-filter-enabled=false").run(context ->
                assertFalse(context.containsBean("cekatVisitorFilterRegistration")));
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(CekatEventSdkAutoConfiguration.class))
                .run(context -> assertFalse(context.containsBean("cekatVisitorFilterRegistration")));
    }

    @Configuration(proxyBeanMethods = false)
    static class UserClient {
        static final CekatClient CLIENT = new CekatClient("user-token");

        @Bean
        CekatClient cekatClient() {
            return CLIENT;
        }
    }
}
