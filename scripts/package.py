"""Build Firefox and Chrome packages using only the Python standard library."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
dist = root / "dist"
dist.mkdir(exist_ok=True)
files = ["background.js", "LICENSE"]
for directory in ("shared", "popup", "options", "icons"):
    files.extend(str(path.relative_to(root)) for path in sorted((root / directory).glob("*")) if path.is_file())
for browser in ("firefox", "chrome"):
    manifest = json.loads((root / "manifest.json").read_text())
    if browser == "chrome":
        manifest.pop("browser_specific_settings")
        manifest.pop("host_permissions")
        manifest["permissions"] = [permission for permission in manifest["permissions"]
                                   if permission not in ("webRequest", "webRequestBlocking")]
        manifest["background"] = {"service_worker": "background.js"}
        manifest["minimum_chrome_version"] = "102"
        for icons in (manifest["icons"], manifest["action"]["default_icon"]):
            for size in icons:
                icons[size] = f"icons/sorter-{size}.png"
    suffix = ".xpi" if browser == "firefox" else "-chrome.zip"
    output = dist / f"download-valet-{manifest['version']}{suffix}"
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        for name in files:
            archive.write(root / name, name)
    print(output)
