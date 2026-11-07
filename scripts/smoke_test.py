"""Exercise a packaged extension in an isolated browser profile. No Python dependencies.

Usage: python3 scripts/smoke_test.py --geckodriver /path/to/geckodriver --firefox /path/to/firefox
"""
import argparse
import base64
import json
import os
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zipfile import ZipFile


def wait_for(check, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("Condition did not become true before timeout")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("firefox", "chrome"), default="firefox")
    parser.add_argument("--geckodriver", default="geckodriver")
    parser.add_argument("--firefox", default="firefox")
    parser.add_argument("--chromedriver", default="chromedriver")
    parser.add_argument("--chrome", default="chromium")
    parser.add_argument("--artifacts", default="/tmp/download-valet-smoke")
    args = parser.parse_args()
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parent.parent
    firefox = args.browser == "firefox"
    version = json.loads((root / "manifest.json").read_text())["version"]
    suffix = ".xpi" if firefox else "-chrome.zip"
    archive = root / "dist" / f"download-valet-{version}{suffix}"
    assert archive.exists(), "Run npm run package first"
    requests = Counter()
    payload = b"%PDF-1.4\n" + b"download-valet-test\n" * 4096

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b'<html><title>Download fixtures</title><body>Local download fixtures</body></html>')
                return
            requests[self.path] += 1
            copy = requests[self.path] % 2 == 0
            data = payload
            status = 200
            mime = "application/pdf"
            if copy and self.path == "/failed.pdf":
                status, mime, data = 403, "text/plain", b"Single-use link expired"
            if copy and self.path == "/different.pdf":
                mime, data = "text/html", b"<html>Please sign in</html>"
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Disposition", f'attachment; filename="{self.path[1:]}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                if self.path == "/slow.pdf" and (copy or not firefox):
                    for offset in range(0, len(data), 4096):
                        self.wfile.write(data[offset:offset + 4096])
                        self.wfile.flush()
                        time.sleep(0.1)
                else:
                    self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    fixtures = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=fixtures.serve_forever, daemon=True).start()
    fixture_url = f"http://127.0.0.1:{fixtures.server_port}"
    driver_port = 4449
    driver_url = f"http://127.0.0.1:{driver_port}"
    session = None
    with tempfile.TemporaryDirectory(prefix=f"download-valet-{args.browser}-") as temporary:
        downloads = Path(temporary) / "downloads"
        downloads.mkdir()
        extension = Path(temporary) / "extension"
        if not firefox:
            with ZipFile(archive) as package:
                package.extractall(extension)
        with (artifacts / f"{args.browser}-driver.log").open("w") as log:
            driver_command = [args.geckodriver, "--port", str(driver_port)] if firefox else [args.chromedriver, f"--port={driver_port}"]
            driver = subprocess.Popen(driver_command, stdout=log, stderr=log,
                                      env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"})

            def command(method, path, value=None):
                body = None if value is None else json.dumps(value).encode()
                request = Request(driver_url + path, data=body, method=method, headers={"Content-Type": "application/json"})
                try:
                    with urlopen(request, timeout=45) as response:
                        return json.load(response)["value"]
                except HTTPError as error:
                    raise AssertionError(error.read().decode()) from error

            def driver_ready():
                try:
                    return command("GET", "/status")["ready"]
                except URLError:
                    return False

            try:
                wait_for(driver_ready)
                capabilities = {
                    "browserName": "firefox",
                    "moz:firefoxOptions": {
                        "binary": args.firefox,
                        "args": ["-headless"],
                        "prefs": {
                            "browser.download.folderList": 2,
                            "browser.download.dir": str(downloads),
                            "browser.download.useDownloadDir": True,
                            "browser.download.always_ask_before_handling_new_types": False,
                            "pdfjs.disabled": True,
                            "browser.shell.checkDefaultBrowser": False,
                            "extensions.webextensions.uuids": json.dumps({"download-sorter@tiagovla": "f6937184-43a7-4e55-ade7-c2d449455d0a"})
                        }
                    }
                } if firefox else {
                    "browserName": "chrome",
                    "goog:chromeOptions": {
                        "binary": args.chrome,
                        "args": ["--headless=new", "--no-first-run", "--no-default-browser-check",
                                 f"--load-extension={extension}", f"--disable-extensions-except={extension}"],
                        "prefs": {
                            "download.default_directory": str(downloads),
                            "download.prompt_for_download": False,
                            "plugins.always_open_pdf_externally": True,
                            "profile.default_content_setting_values.automatic_downloads": 1
                        }
                    }
                }
                created = command("POST", "/session", {"capabilities": {"alwaysMatch": capabilities}})
                session = created["sessionId"]
                prefix = f"/session/{session}"

                def run(script):
                    return command("POST", prefix + "/execute/sync", {"script": script, "args": []})

                def storage():
                    return command("POST", prefix + "/execute/async", {
                        "script": "const done = arguments[arguments.length-1]; (globalThis.browser || chrome).storage.local.get(null).then(done, error => done({error: error.message}));",
                        "args": []
                    })

                def navigate(url):
                    if firefox and url.startswith("moz-extension:"):
                        command("POST", prefix + "/moz/context", {"context": "chrome"})
                        run(f"gBrowser.selectedBrowser.loadURI(Services.io.newURI({json.dumps(url)}), {{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}})")
                        command("POST", prefix + "/moz/context", {"context": "content"})
                        def loaded():
                            for handle in command("GET", prefix + "/window/handles"):
                                command("POST", prefix + "/window", {"handle": handle})
                                if command("GET", prefix + "/url") == url and run("return document.readyState") == "complete":
                                    return True
                            return False
                        wait_for(loaded)
                    else:
                        command("POST", prefix + "/url", {"url": url})

                def download(name):
                    navigate(fixture_url)
                    run(f"const a = document.createElement('a'); a.href = {json.dumps(fixture_url + '/' + name)}; document.body.append(a); a.click();")

                if firefox:
                    addon = command("POST", prefix + "/moz/addon/install", {"path": str(archive), "temporary": True})
                    assert addon == "download-sorter@tiagovla"
                    options_url = "moz-extension://f6937184-43a7-4e55-ade7-c2d449455d0a/options/options.html"
                else:
                    def extension_base():
                        targets = command("POST", prefix + "/goog/cdp/execute", {"cmd": "Target.getTargets", "params": {}})
                        return next((target["url"].rsplit("/", 1)[0] for target in targets["targetInfos"]
                                     if target["type"] == "service_worker" and target["url"].startswith("chrome-extension://")), None)
                    options_url = wait_for(extension_base) + "/options/options.html"
                navigate(options_url)
                default_names = run("return DownloadSorter.DEFAULT_RULES.map(rule => rule.name)")
                default_count = len(default_names)
                wait_for(lambda: run("return document.querySelectorAll('.rule').length") == default_count)
                assert "Download Valet" in run("return document.title")
                assert run("return document.querySelector('#firefox-note').hidden") == (not firefox)
                run("document.querySelector('#try-name').value = 'report.pdf'; document.querySelector('#try-name').dispatchEvent(new Event('input'))")
                assert "Documents/report.pdf" in run("return document.querySelector('#try-result').textContent")
                print(f"PASS: add-on loads; {default_count} rules render; filename preview works", flush=True)

                download("sample.pdf")
                wait_for(lambda: (downloads / "Documents/sample.pdf").exists() and not (downloads / "sample.pdf").exists())
                assert (downloads / "Documents/sample.pdf").read_bytes() == payload
                assert requests["/sample.pdf"] == (2 if firefox else 1)
                download("sample.pdf")
                wait_for(lambda: len(list((downloads / "Documents").glob("sample*.pdf"))) == 2 and not (downloads / "sample.pdf").exists())
                print("PASS: real downloads route correctly; conflicts keep both files", flush=True)

                for name in ("failed.pdf", "different.pdf"):
                    download(name)
                    if firefox:
                        wait_for(lambda: requests['/' + name] == 2)
                        navigate(options_url)
                        wait_for(lambda: any(entry.get("file") == name and entry.get("status") == "left" for entry in storage().get("log", [])))
                        assert (downloads / name).read_bytes() == payload
                        assert not (downloads / "Documents" / name).exists()
                    else:
                        wait_for(lambda: (downloads / "Documents" / name).exists())
                        assert (downloads / "Documents" / name).read_bytes() == payload
                        assert requests['/' + name] == 1
                print("PASS: failed replacements preserve originals" if firefox else "PASS: single-use links sort with one request", flush=True)

                download("slow.pdf")
                wait_for(lambda: requests["/slow.pdf"] == (2 if firefox else 1))
                time.sleep(0.3)
                if firefox:
                    assert (downloads / "slow.pdf").read_bytes() == payload
                try:
                    wait_for(lambda: not (downloads / "slow.pdf").exists() and (downloads / "Documents/slow.pdf").exists()
                             and (downloads / "Documents/slow.pdf").stat().st_size == len(payload))
                except AssertionError:
                    navigate(options_url)
                    print("Activity:", storage(), flush=True)
                    print("Downloads:", command("POST", prefix + "/execute/async", {
                        "script": "const done = arguments[arguments.length-1]; (globalThis.browser || chrome).downloads.search({}).then(done);", "args": []
                    }), flush=True)
                    raise
                assert (downloads / "Documents/slow.pdf").read_bytes() == payload
                print("PASS: source remains intact during replacement" if firefox else "PASS: slow download saves directly to its destination", flush=True)

                navigate(options_url)
                run("document.querySelector('#enabled').click()")
                wait_for(lambda: storage().get("settings", {}).get("enabled") is False)
                download("paused.pdf")
                wait_for(lambda: (downloads / "paused.pdf").exists())
                time.sleep(0.3)
                assert requests["/paused.pdf"] == 1
                assert not (downloads / "Documents/paused.pdf").exists()
                navigate(options_url)
                run("document.querySelector('#enabled').click()")
                wait_for(lambda: storage().get("settings", {}).get("enabled") is True)
                image_row = "Array.from(document.querySelectorAll('.rule')).find(row => row.querySelector('.rule-name').value === 'Images')"
                run(f"const folder = {image_row}.querySelector('.rule-folder'); folder.value = 'Photos/{{YYYY}}-{{MM}}'; folder.dispatchEvent(new Event('input'))")
                wait_for(lambda: next(rule for rule in storage()["settings"]["rules"] if rule["name"] == "Images")["folder"] == "Photos/{YYYY}-{MM}")
                navigate(options_url)
                assert run(f"return {image_row}.querySelector('.rule-folder').value") == "Photos/{YYYY}-{MM}"
                run(f"const field = {image_row}.querySelector('.rule-extensions'); field.value = 'webp, png, .JPG'; field.dispatchEvent(new Event('input')); field.dispatchEvent(new Event('blur'))")
                wait_for(lambda: next(rule for rule in storage()["settings"]["rules"] if rule["name"] == "Images")["extensions"] == ["jpg", "png", "webp"])
                assert run(f"return {image_row}.querySelector('.rule-extensions').value") == "jpg, png, webp"
                print("PASS: pause prevents replay; edited rules survive reload", flush=True)

                run("document.querySelector('#add-rule').click()")
                wait_for(lambda: run("return document.querySelectorAll('.rule').length") == default_count + 1)
                run("const row = document.querySelector('.rule'); for (const [selector, value] of [['.rule-name', 'Research'], ['.rule-extensions', 'pdf'], ['.rule-folder', 'Research/{YYYY}']]) { const field = row.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input')); }")
                wait_for(lambda: storage()["settings"]["rules"][0]["folder"] == "Research/{YYYY}")
                run("document.querySelector('#try-name').value = 'report.pdf'; document.querySelector('#try-name').dispatchEvent(new Event('input'))")
                assert "Research/" in run("return document.querySelector('#try-result').textContent")
                run("document.querySelector('.rule .move-down').click()")
                wait_for(lambda: storage()["settings"]["rules"][1]["name"] == "Research")
                run("document.querySelectorAll('.rule')[1].querySelector('.move-up').click()")
                wait_for(lambda: storage()["settings"]["rules"][0]["name"] == "Research")
                run("document.querySelector('.rule-enabled').click()")
                wait_for(lambda: storage()["settings"]["rules"][0]["enabled"] is False)
                assert "Documents/report.pdf" in run("return document.querySelector('#try-result').textContent")
                run("document.querySelector('.rule .delete').click()")
                wait_for(lambda: len(storage()["settings"]["rules"]) == default_count)
                run("document.querySelector('#status-action').click()")
                wait_for(lambda: len(storage()["settings"]["rules"]) == default_count + 1)
                run("document.querySelector('.rule .delete').click()")
                wait_for(lambda: len(storage()["settings"]["rules"]) == default_count)
                print("PASS: rule creation, editing, priority, pause, deletion, and undo work", flush=True)

                run("document.querySelector('#restore-defaults').click()")
                wait_for(lambda: next(rule for rule in storage()["settings"]["rules"] if rule["name"] == "Images")["folder"] == "Images")
                assert run("return Array.from(document.querySelectorAll('.rule-name'), field => field.value)") == default_names
                for name, folder in {"slides.pptx": "Documents", "budget.xlsx": "Documents", "backup.zip": "Compressed",
                                     "logo.psd": "Graphics", "model.stl": "3D Models", "config.json": "Data", "system.iso": "Disk Images"}.items():
                    run(f"const field = document.querySelector('#try-name'); field.value = {json.dumps(name)}; field.dispatchEvent(new Event('input'))")
                    assert f"{folder}/{name}" in run("return document.querySelector('#try-result').textContent")
                print("PASS: revised categories, sorted extensions, and Reset rules work", flush=True)

                command("POST", prefix + "/window/rect", {"width": 1440, "height": 1100})
                run("window.scrollTo(0, 0)")
                assert run("return document.documentElement.scrollWidth <= innerWidth")
                assert run("return getComputedStyle(document.querySelector('#rule-list')).gridTemplateColumns.split(' ').length") == 2
                (artifacts / "options.png").write_bytes(base64.b64decode(command("GET", prefix + "/screenshot")))
                command("POST", prefix + "/window/rect", {"width": 480, "height": 1000})
                assert run("return document.documentElement.scrollWidth <= innerWidth")
                assert run("return getComputedStyle(document.querySelector('#rule-list')).gridTemplateColumns.split(' ').length") == 1
                (artifacts / "options-mobile.png").write_bytes(base64.b64decode(command("GET", prefix + "/screenshot")))
                run("document.querySelector('#routing').scrollIntoView()")
                (artifacts / "options-mobile-rules.png").write_bytes(base64.b64decode(command("GET", prefix + "/screenshot")))
                command("POST", prefix + "/window/rect", {"width": 1440, "height": 1100})
                if firefox:
                    command("POST", prefix + "/moz/context", {"context": "chrome"})
                    run("Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', 0)")
                    command("POST", prefix + "/moz/context", {"context": "content"})
                else:
                    command("POST", prefix + "/goog/cdp/execute", {
                        "cmd": "Emulation.setEmulatedMedia", "params": {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}
                    })
                wait_for(lambda: run("return matchMedia('(prefers-color-scheme: dark)').matches"))
                run("window.scrollTo(0, 0)")
                (artifacts / "options-dark.png").write_bytes(base64.b64decode(command("GET", prefix + "/screenshot")))
                print("PASS: desktop, mobile, and dark layouts render without horizontal overflow", flush=True)
                navigate(options_url.replace("options/options.html", "popup/popup.html"))
                wait_for(lambda: run("return document.querySelectorAll('.entry').length") > 0)
                time.sleep(0.2)  # Let the switch's initial CSS transition finish before capturing it.
                (artifacts / "popup.png").write_bytes(base64.b64decode(command("GET", prefix + "/screenshot")))
                print(f"PASS: popup renders activity; screenshots in {artifacts}", flush=True)
            finally:
                if session:
                    command("DELETE", f"/session/{session}")
                driver.terminate()
                driver.wait(timeout=10)
                fixtures.shutdown()


if __name__ == "__main__":
    main()
