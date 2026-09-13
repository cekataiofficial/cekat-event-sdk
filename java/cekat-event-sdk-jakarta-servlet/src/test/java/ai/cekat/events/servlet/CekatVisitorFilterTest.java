package ai.cekat.events.servlet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.cekat.events.CekatClient;
import ai.cekat.events.CekatClientOptions;
import ai.cekat.events.Event;
import ai.cekat.events.VisitorContext;
import ai.cekat.events.transport.TransportResponse;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import org.apache.tomcat.util.descriptor.web.ErrorPage;
import org.apache.tomcat.util.descriptor.web.FilterDef;
import org.apache.tomcat.util.descriptor.web.FilterMap;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class CekatVisitorFilterTest {
    private static final ConcurrentLinkedQueue<String> SENT_VISITORS = new ConcurrentLinkedQueue<>();
    private static final List<String> OBSERVATIONS = new CopyOnWriteArrayList<>();
    private static final CountDownLatch ASYNC_DONE = new CountDownLatch(1);
    private static final CekatClient CLIENT = new CekatClient("token", CekatClientOptions.builder().transport(request -> {
        String body = new String(request.body(), StandardCharsets.UTF_8);
        int start = body.indexOf("\"visitor_id\":\"");
        SENT_VISITORS.add(start < 0 ? "<none>" : body.substring(start + 14, body.indexOf('"', start + 14)));
        byte[] ok = ("{\"success\":true,\"data\":{\"success\":true,\"message\":\"accepted\",\"event_key\":\"user_login\","
                + "\"validated_properties\":[]}}").getBytes(StandardCharsets.UTF_8);
        return new TransportResponse(200, Map.of(), ok, false, ok.length, null);
    }).build());

    private static Tomcat tomcat;
    private static String origin;
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @BeforeAll
    static void startTomcat() throws Exception {
        tomcat = new Tomcat();
        tomcat.setBaseDir(Files.createTempDirectory("cekat-tomcat").toString());
        tomcat.setPort(0);
        tomcat.getConnector();
        Context context = tomcat.addContext("", null);

        addFilter(context, "outer", new Filter() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response,
                    jakarta.servlet.FilterChain chain) throws IOException, jakarta.servlet.ServletException {
                HttpServletRequest http = (HttpServletRequest) request;
                chain.doFilter(request, response);
                if (http.getDispatcherType() == DispatcherType.REQUEST && !http.isAsyncStarted()) {
                    OBSERVATIONS.add("sync-cleared=" + (http.getAttribute(CekatServletRequest.VISITOR_ID_ATTRIBUTE) == null));
                } else if (http.isAsyncStarted() && http.getDispatcherType() == DispatcherType.REQUEST) {
                    http.getAsyncContext().addListener(new AsyncListener() {
                        @Override
                        public void onComplete(AsyncEvent event) {
                            OBSERVATIONS.add("async-cleared=" + (http.getAttribute(CekatServletRequest.VISITOR_ID_ATTRIBUTE) == null));
                            ASYNC_DONE.countDown();
                        }

                        @Override
                        public void onTimeout(AsyncEvent event) {
                        }

                        @Override
                        public void onError(AsyncEvent event) {
                        }

                        @Override
                        public void onStartAsync(AsyncEvent event) {
                        }
                    });
                }
                OBSERVATIONS.add("dispatch-thread-clean=" + VisitorContext.currentVisitorId().isEmpty());
            }
        });
        addFilter(context, "cekat", new CekatVisitorFilter());
        addServlet(context, "/sync", new HttpServlet() {
            @Override
            protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
                try {
                    CLIENT.userLogin(Event.builder().email("a@b.c").visitorId(request.getParameter("explicit")).build());
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                response.getWriter().write(VisitorContext.currentVisitorId().orElse("<none>") + "|"
                        + request.getAttribute(CekatServletRequest.VISITOR_ID_ATTRIBUTE));
            }
        });
        addServlet(context, "/async", new HttpServlet() {
            @Override
            protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
                if (request.getDispatcherType() == DispatcherType.REQUEST) {
                    AsyncContext async = request.startAsync();
                    async.start(() -> {
                        OBSERVATIONS.add("container-thread=" + VisitorContext.currentVisitorId().orElse("<none>"));
                        async.dispatch();
                    });
                    return;
                }
                String inFuture = CompletableFuture.supplyAsync(() -> VisitorContext.currentVisitorId().orElse("<none>")).join();
                response.getWriter().write(request.getDispatcherType() + ":" + VisitorContext.currentVisitorId().orElse("<none>")
                        + ":future=" + inFuture);
            }
        });
        addServlet(context, "/boom", new HttpServlet() {
            @Override
            protected void doGet(HttpServletRequest request, HttpServletResponse response) {
                throw new IllegalStateException("downstream failure");
            }
        });
        addServlet(context, "/error-page", new HttpServlet() {
            @Override
            protected void service(HttpServletRequest request, HttpServletResponse response) throws IOException {
                response.setStatus(500);
                response.getWriter().write(request.getDispatcherType() + ":" + VisitorContext.currentVisitorId().orElse("<none>"));
            }
        });
        ErrorPage errorPage = new ErrorPage();
        errorPage.setExceptionType(IllegalStateException.class.getName());
        errorPage.setLocation("/error-page");
        context.addErrorPage(errorPage);
        tomcat.start();
        origin = "http://127.0.0.1:" + tomcat.getConnector().getLocalPort();
    }

    @AfterAll
    static void stopTomcat() throws Exception {
        tomcat.stop();
        tomcat.destroy();
    }

    private static void addFilter(Context context, String name, Filter filter) {
        FilterDef definition = new FilterDef();
        definition.setFilterName(name);
        definition.setFilter(filter);
        definition.setAsyncSupported("true");
        context.addFilterDef(definition);
        FilterMap mapping = new FilterMap();
        mapping.setFilterName(name);
        mapping.addURLPattern("/*");
        mapping.setDispatcher(DispatcherType.REQUEST.name());
        mapping.setDispatcher(DispatcherType.ASYNC.name());
        mapping.setDispatcher(DispatcherType.ERROR.name());
        context.addFilterMap(mapping);
    }

    private static void addServlet(Context context, String path, HttpServlet servlet) {
        Tomcat.addServlet(context, path, servlet).setAsyncSupported(true);
        context.addServletMapping(path, path);
    }

    private static HttpResponse<String> call(String method, String path, Map<String, String> headers) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(origin + path)).method(method, HttpRequest.BodyPublishers.noBody());
        headers.forEach(builder::header);
        return HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void scopesHeaderThenCookieAndCleansUpSynchronousRequests() throws Exception {
        SENT_VISITORS.clear();
        assertEquals("header|header", call("POST", "/sync", Map.of("X-Cekat-Visitor-ID", " header ", "Cookie", "_cekat_visitor_id=cookie")).body());
        assertEquals("cookie|cookie", call("POST", "/sync", Map.of("Cookie", "a=1; _cekat_visitor_id= cookie ")).body());
        assertEquals("<none>|null", call("POST", "/sync", Map.of()).body());
        assertEquals("header|header", call("POST", "/sync?explicit=%20explicit%20", Map.of("X-Cekat-Visitor-ID", "header")).body());
        assertEquals(List.of("header", "cookie", "<none>", "explicit"), List.copyOf(SENT_VISITORS));
        assertTrue(OBSERVATIONS.contains("sync-cleared=true"));
        assertTrue(OBSERVATIONS.stream().noneMatch(observation -> observation.equals("sync-cleared=false")));
    }

    @Test
    void asyncDispatchReusesTheRequestVisitorWithoutPropagatingToOtherThreads() throws Exception {
        HttpResponse<String> response = call("GET", "/async", Map.of("X-Cekat-Visitor-ID", "async-visitor"));
        assertEquals("ASYNC:async-visitor:future=<none>", response.body());
        assertTrue(ASYNC_DONE.await(5, TimeUnit.SECONDS));
        assertTrue(OBSERVATIONS.contains("container-thread=<none>"));
        assertTrue(OBSERVATIONS.contains("async-cleared=true"));
        assertTrue(OBSERVATIONS.stream().noneMatch(observation -> observation.equals("dispatch-thread-clean=false")));
    }

    @Test
    void errorDispatchSeesTheVisitor() throws Exception {
        HttpResponse<String> response = call("GET", "/boom", Map.of("X-Cekat-Visitor-ID", "error-visitor"));
        assertEquals(500, response.statusCode());
        assertEquals("ERROR:error-visitor", response.body());
    }

    @Test
    void isolatesConcurrentRequests() throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(8);
        try {
            List<Future<String>> results = new java.util.ArrayList<>();
            for (int index = 0; index < 40; index++) {
                String visitor = "visitor-" + index;
                results.add(executor.submit(() -> call("POST", "/sync", Map.of("X-Cekat-Visitor-ID", visitor)).body()));
            }
            for (int index = 0; index < 40; index++) {
                assertEquals("visitor-" + index + "|visitor-" + index, results.get(index).get());
            }
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void resolvesFromParsedCookiesWhenNoRawHeaderIsAvailable() {
        HttpServletRequest request = (HttpServletRequest) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] {HttpServletRequest.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "getCookies" -> new jakarta.servlet.http.Cookie[] {new jakarta.servlet.http.Cookie("_cekat_visitor_id", "parsed")};
                    case "getHeaders" -> java.util.Collections.emptyEnumeration();
                    default -> null;
                });
        assertEquals(Optional.of("parsed"), CekatServletRequest.visitorId(request));
    }
}
