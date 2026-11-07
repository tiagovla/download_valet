"""Check that both browser packages are installable and share their runtime code."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent


class PackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(ROOT / "scripts/package.py")], check=True, capture_output=True)
        version = json.loads((ROOT / "manifest.json").read_text())["version"]
        cls.firefox = ROOT / "dist" / f"download-valet-{version}.xpi"
        cls.chrome = ROOT / "dist" / f"download-valet-{version}-chrome.zip"

    def test_browser_manifests(self):
        with ZipFile(self.firefox) as firefox, ZipFile(self.chrome) as chrome:
            original = json.loads((ROOT / "manifest.json").read_text())
            ff = json.loads(firefox.read("manifest.json"))
            ch = json.loads(chrome.read("manifest.json"))
            self.assertEqual(ff, original)
            self.assertEqual(ch["background"], {"service_worker": "background.js"})
            self.assertNotIn("browser_specific_settings", ch)
            self.assertEqual(ch["permissions"], ff["permissions"])
            self.assertEqual(ch["options_ui"], ff["options_ui"])
            self.assertEqual(ch["manifest_version"], 3)

    def test_packaged_assets_and_png_dimensions(self):
        for package in (self.firefox, self.chrome):
            with self.subTest(package=package.name), ZipFile(package) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                paths = [manifest["action"]["default_popup"], manifest["options_ui"]["page"]]
                if "service_worker" in manifest["background"]:
                    paths.append(manifest["background"]["service_worker"])
                else:
                    paths.extend(manifest["background"]["scripts"])
                for icons in (manifest["icons"], manifest["action"]["default_icon"]):
                    paths.extend(icons.values())
                    if package == self.chrome:
                        for size, path in icons.items():
                            data = archive.read(path)
                            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
                            self.assertEqual(struct.unpack(">II", data[16:24]), (int(size), int(size)))
                for path in paths:
                    self.assertIn(path, archive.namelist())

    def test_shared_code_notices_and_excluded_development_files(self):
        with ZipFile(self.firefox) as firefox, ZipFile(self.chrome) as chrome:
            self.assertEqual(set(firefox.namelist()), set(chrome.namelist()))
            for path in firefox.namelist():
                self.assertFalse(path.startswith(("tests/", "scripts/", "META-INF/", ".")))
                if path != "manifest.json":
                    self.assertEqual(firefox.read(path), chrome.read(path))
            self.assertIn("LICENSE", chrome.namelist())
            self.assertEqual(chrome.read("background.js"), (ROOT / "background.js").read_bytes())


if __name__ == "__main__":
    unittest.main()
