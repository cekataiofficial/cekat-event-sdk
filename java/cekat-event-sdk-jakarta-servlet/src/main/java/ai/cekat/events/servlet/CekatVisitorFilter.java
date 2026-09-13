package ai.cekat.events.servlet;

import ai.cekat.events.VisitorContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;

/**
 * Scopes the request's visitor ID for {@link ai.cekat.events.CekatClient} calls made while a dispatch runs.
 *
 * <p>Register for the {@code REQUEST}, {@code ASYNC}, and {@code ERROR} dispatcher types with async support. The
 * visitor is resolved once and stored in {@link CekatServletRequest#VISITOR_ID_ATTRIBUTE}; each dispatch opens a
 * thread scope that is closed when the dispatch returns. The attribute is removed when the request completes, errors,
 * or times out. The scope does not propagate into executor tasks started by the application.
 */
public final class CekatVisitorFilter implements Filter {
    private static final String LISTENER_ATTRIBUTE = "ai.cekat.events.servlet.listener.v1";

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest http)) {
            chain.doFilter(request, response);
            return;
        }
        if (http.getDispatcherType() == DispatcherType.REQUEST) {
            CekatServletRequest.store(http);
        }
        try (VisitorContext.Scope ignored = CekatServletRequest.openScope(http)) {
            chain.doFilter(request, response);
        } finally {
            if (http.isAsyncStarted()) {
                registerCleanup(http);
            } else if (http.getDispatcherType() == DispatcherType.REQUEST) {
                CekatServletRequest.clear(http);
            }
        }
    }

    private static void registerCleanup(HttpServletRequest request) {
        if (request.getAttribute(LISTENER_ATTRIBUTE) == request.getAsyncContext()) {
            return;
        }
        request.setAttribute(LISTENER_ATTRIBUTE, request.getAsyncContext());
        request.getAsyncContext().addListener(new CleanupListener(request));
    }

    /** Removes the request attributes when an async cycle ends, and follows restarted cycles. */
    private static final class CleanupListener implements AsyncListener {
        private final HttpServletRequest request;

        CleanupListener(HttpServletRequest request) {
            this.request = request;
        }

        @Override
        public void onComplete(AsyncEvent event) {
            clear();
        }

        @Override
        public void onTimeout(AsyncEvent event) {
            clear();
        }

        @Override
        public void onError(AsyncEvent event) {
            clear();
        }

        @Override
        public void onStartAsync(AsyncEvent event) {
            request.setAttribute(LISTENER_ATTRIBUTE, event.getAsyncContext());
            event.getAsyncContext().addListener(this);
        }

        private void clear() {
            try {
                CekatServletRequest.clear(request);
                request.removeAttribute(LISTENER_ATTRIBUTE);
            } catch (IllegalStateException recycled) {
                // The container already recycled the request; its attributes are gone.
            }
        }
    }
}
