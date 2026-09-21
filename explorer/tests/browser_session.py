import time


class BrowserSession:
    def __init__(self, page, url, errors):
        self.page, self.url, self.errors = page, url, errors

    def state(self):
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
            self.page.wait_for_timeout(50)

    def settled(self):
        return self.wait(lambda state: state.get("rendered") and state["rendered"]["revision"] == state["revision"])

    def command(self, name, data=None):
        response = self.page.request.post(self.url + "api/command", data={"name": name, "input": data or {}})
        assert response.ok, response.text()
        return self.settled()

    def resize(self, width, height):
        self.page.set_viewport_size({"width": width, "height": height})
        self.page.wait_for_function("""() => {
            const canvas = document.querySelector('canvas[aria-label="Interactive STEP assembly"]');
            if (!canvas) return false;
            const bounds = canvas.getBoundingClientRect(), dpr = Math.min(2, Math.max(1, devicePixelRatio));
            return Math.abs(canvas.width - bounds.width * dpr) <= 1 &&
                   Math.abs(canvas.height - bounds.height * dpr) <= 1;
        }""")
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
