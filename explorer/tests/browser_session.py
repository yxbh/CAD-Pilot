import contextlib
import time

from playwright.sync_api import Error, expect
from playwright.sync_api import sync_playwright as _own_playwright

# The Playwright and Chromium that browser_host.py shares across the scenarios it runs; None in a scenario run alone.
_shared = None


@contextlib.contextmanager
def host():
    """Start the Playwright and Chromium that scenarios run by browser_host.py share."""
    global _shared
    with _own_playwright() as playwright:
        _shared = _Shared(playwright)
        try:
            yield
        finally:
            _shared.close()
            _shared = None


class _Shared:
    def __init__(self, playwright):
        self.playwright, self._browser = playwright, None

    def browser(self):
        if self._browser is None or not self._browser.is_connected():
            self._browser = self.playwright.chromium.launch()
        return self._browser

    def close(self):
        if self._browser is not None and self._browser.is_connected():
            self._browser.close()


class _Contexts:
    """The shared Chromium as one scenario sees it: closing it closes the contexts and pages the scenario opened."""

    def __init__(self, browser):
        self._browser, self._opened = browser, []

    def new_context(self, **options):
        context = self._browser.new_context(**options)
        self._opened.append(context)
        return context

    def new_page(self, **options):
        return self.new_context(**options).new_page()

    def close(self):
        for context in self._opened:
            with contextlib.suppress(Error):
                context.close()
        self._opened.clear()


@contextlib.contextmanager
def sync_playwright():
    """Playwright for a scenario: the host's when browser_host.py runs it, otherwise its own."""
    if _shared is not None:
        yield _shared.playwright
    else:
        with _own_playwright() as playwright:
            yield playwright


def launch_chromium(playwright):
    """Every scenario's browser: fresh contexts in the host's Chromium, or a Chromium of its own when run alone.
    Expectations get the same 30 s as wait(): on a busy machine or CI runner a reload can take longer than
    Playwright's 5 s default."""
    expect.set_options(timeout=30_000)
    if _shared is not None:
        return _Contexts(_shared.browser())
    return playwright.chromium.launch()


class BrowserSession:
    def __init__(self, page, url, errors):
        self.page, self.url, self.errors = page, url, errors

    def state(self):
        # Reading state has no effect, so a request on a connection the server reset is simply repeated once.
        try:
            response = self.page.request.get(self.url + "api/state")
        except Error as error:
            if "ECONNRESET" not in str(error):
                raise
            response = self.page.request.get(self.url + "api/state")
        assert response.ok, response.text()
        return response.json()

    def wait(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            current = self.state()
            if predicate(current):
                return current
            assert time.monotonic() < deadline, (
                f"State did not settle: {current}; errors={self.errors}; "
                f"alerts={self.page.get_by_role('alert').all_text_contents()}"
            )
            # Short polls: most waits are for one rendered frame, so a long interval would add up across a scenario.
            self.page.wait_for_timeout(10)

    def settled(self):
        return self.wait(lambda state: state.get("rendered") and state["rendered"]["revision"] == state["revision"])

    def command(self, name, data=None):
        response = self.page.request.post(self.url + "api/command", data={"name": name, "input": data or {}})
        assert response.ok, response.text()
        return self.settled()

    def resize(self, width, height):
        self.page.set_viewport_size({"width": width, "height": height})
        self.page.wait_for_function("""() => {
            const canvas = document.querySelector('canvas[aria-label="Interactive model"]');
            if (!canvas) return false;
            const bounds = canvas.getBoundingClientRect(), dpr = Math.min(2, Math.max(1, devicePixelRatio));
            return Math.abs(canvas.width - bounds.width * dpr) <= 1 &&
                   Math.abs(canvas.height - bounds.height * dpr) <= 1;
        }""")
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
