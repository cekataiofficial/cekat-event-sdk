package ai.cekat.events.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.CekatClient;
import ai.cekat.events.CekatClientOptions;
import ai.cekat.events.Event;
import ai.cekat.events.VisitorContext;
import ai.cekat.events.servlet.CekatServletRequest;
import ai.cekat.events.transport.TransportResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@SpringBootTest(classes = CekatSpringMvcIntegrationTest.TestApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CekatSpringMvcIntegrationTest {
    static final List<String> SENT = new CopyOnWriteArrayList<>();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @Value("${local.server.port}")
    int port;

    private HttpResponse<String> call(String method, String path, Map<String, String> headers) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .method(method, HttpRequest.BodyPublishers.noBody());
        headers.forEach(builder::header);
        return HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void controllersSendTheRequestVisitor() throws Exception {
        SENT.clear();
        assertEquals("header", call("POST", "/orders", Map.of("X-Cekat-Visitor-ID", " header ", "Cookie", "_cekat_visitor_id=cookie")).body());
        assertEquals("cookie", call("POST", "/orders", Map.of("Cookie", "_cekat_visitor_id=cookie")).body());
        assertEquals("header", call("POST", "/orders?explicit=explicit", Map.of("X-Cekat-Visitor-ID", "header")).body());
        assertEquals("<none>", call("POST", "/orders", Map.of()).body());
        assertEquals(List.of("header", "cookie", "explicit", "<none>"), SENT.stream().map(body -> {
            int start = body.indexOf("\"visitor_id\":\"");
            return start < 0 ? "<none>" : body.substring(start + 14, body.indexOf('"', start + 14));
        }).toList());
        assertTrue(SENT.get(0).contains("\"properties\":{\"order_id\":\"ord-1\",\"amount\":125000,\"currency\":\"IDR\"}"), SENT.get(0));
    }

    @Test
    void asyncControllersKeepTheRequestAttributeButNotTheThreadScope() throws Exception {
        assertEquals("attribute=async-visitor,worker-thread=<none>",
                call("GET", "/async", Map.of("X-Cekat-Visitor-ID", "async-visitor")).body());
    }

    @Test
    void failuresReachTheErrorDispatchWithoutLeaking() throws Exception {
        HttpResponse<String> response = call("GET", "/boom", Map.of("X-Cekat-Visitor-ID", "failing"));
        assertEquals(500, response.statusCode());
        assertEquals("<none>", call("POST", "/orders", Map.of()).body());
    }

    @SpringBootApplication
    static class TestApplication {
        @Bean
        CekatClient cekatClient() {
            return new CekatClient("token", CekatClientOptions.builder().transport(request -> {
                SENT.add(new String(request.body(), StandardCharsets.UTF_8));
                byte[] ok = ("{\"success\":true,\"data\":{\"success\":true,\"message\":\"accepted\",\"event_key\":\"order_paid\","
                        + "\"validated_properties\":[]}}").getBytes(StandardCharsets.UTF_8);
                return new TransportResponse(200, Map.of(), ok, false, ok.length, null);
            }).build());
        }

        @RestController
        static class OrdersController {
            private final CekatClient client;

            OrdersController(CekatClient client) {
                this.client = client;
            }

            @PostMapping("/orders")
            String create(@RequestParam(name = "explicit", required = false) String explicit) throws InterruptedException {
                client.orderPaid(new BigDecimal("125000"), "IDR",
                        Event.builder().email("buyer@example.test").visitorId(explicit).property("order_id", "ord-1").build());
                return VisitorContext.currentVisitorId().orElse("<none>");
            }

            @GetMapping("/async")
            Callable<String> async(HttpServletRequest request) {
                return () -> "attribute=" + CekatServletRequest.visitorId(request).orElse("<none>")
                        + ",worker-thread=" + VisitorContext.currentVisitorId().orElse("<none>");
            }

            @GetMapping("/boom")
            String boom() {
                throw new IllegalStateException("downstream failure");
            }
        }
    }
}
