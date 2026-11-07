"""Check that only matching, approved Mozilla packages replace release assets."""
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import sync_firefox as sync

ADDON_ID = "download-sorter@tiagovla"


class SyncFirefoxTest(unittest.TestCase):
    def setUp(self):
        self.release = {
            "tag_name": "v1.0.0",
            "assets": [{"name": "download-valet-1.0.0.xpi", "digest": "sha256:unsigned"},
                       {"name": "download-valet-1.0.0-chrome.zip"}],
            "body": sync.UNSIGNED_NOTICE + "\nKeep these release notes.",
        }
        self.data = self.package()
        self.approved = {
            "version": "1.0.0", "channel": "listed", "file": {
                "status": "public",
                "hash": "sha256:" + hashlib.sha256(self.data).hexdigest(),
                "url": "https://addons.mozilla.org/firefox/downloads/file/123/addon.xpi",
            },
        }

    def package(self, version="1.0.0", addon_id=ADDON_ID, signed=True):
        output = io.BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr("manifest.json", json.dumps({
                "version": version, "browser_specific_settings": {"gecko": {"id": addon_id}},
            }))
            if signed:
                archive.writestr("META-INF/cose.sig", b"test signature fixture")
        return output.getvalue()

    def responses(self):
        return [io.BytesIO(json.dumps(self.approved).encode()), io.BytesIO(self.data)]

    def test_approved_package_replaces_only_firefox_and_preserves_notes(self):
        calls = []

        def gh(*args):
            calls.append(args)
            if args[1] == "upload":
                self.assertEqual(Path(args[3]).name, "download-valet-1.0.0.xpi")
                self.assertEqual(Path(args[3]).read_bytes(), self.data)
                self.assertEqual(args[4], "--clobber")
            else:
                self.assertEqual(args[1:4], ("edit", "v1.0.0", "--notes-file"))
                self.assertEqual(Path(args[4]).read_text(),
                                 sync.SIGNED_NOTICE + "\nKeep these release notes.")

        with patch.object(sync, "urlopen", side_effect=self.responses()), patch.object(sync, "gh", side_effect=gh):
            sync.sync_release(self.release, ADDON_ID)
        self.assertEqual(len(calls), 2)

    def test_not_public_yet_is_skipped(self):
        for status in (401, 404):
            with self.subTest(status=status), patch.object(sync, "urlopen", side_effect=HTTPError(
                    "https://addons.mozilla.org/", status, "Pending", {}, io.BytesIO())), patch.object(sync, "gh") as gh:
                sync.sync_release(self.release, ADDON_ID)
                gh.assert_not_called()

    def test_mozilla_errors_fail_instead_of_hiding_outages(self):
        with patch.object(sync, "urlopen", side_effect=HTTPError(
                "https://addons.mozilla.org/", 503, "Unavailable", {}, io.BytesIO())), patch.object(sync, "gh") as gh:
            with self.assertRaises(HTTPError):
                sync.sync_release(self.release, ADDON_ID)
            gh.assert_not_called()

    def test_unapproved_or_unlisted_packages_are_skipped(self):
        for field, value in (("status", "unreviewed"), ("status", "disabled"), ("channel", "unlisted")):
            self.setUp()
            (self.approved["file"] if field == "status" else self.approved)[field] = value
            with self.subTest(field=field, value=value), patch.object(sync, "urlopen", side_effect=self.responses()) as request, patch.object(sync, "gh") as gh:
                sync.sync_release(self.release, ADDON_ID)
                self.assertEqual(request.call_count, 1)
                gh.assert_not_called()

    def test_already_uploaded_package_does_not_download_or_upload_again(self):
        self.release["assets"][0]["digest"] = self.approved["file"]["hash"]
        self.release["body"] = sync.SIGNED_NOTICE
        with patch.object(sync, "urlopen", side_effect=self.responses()) as request, patch.object(sync, "gh") as gh:
            sync.sync_release(self.release, ADDON_ID)
            self.assertEqual(request.call_count, 1)
            gh.assert_not_called()

    def test_bad_downloads_never_replace_the_asset(self):
        for data in (b"corrupt", self.package(version="2.0.0"),
                     self.package(addon_id="other@example.com"), self.package(signed=False)):
            self.setUp()
            if data != b"corrupt":
                self.approved["file"]["hash"] = "sha256:" + hashlib.sha256(data).hexdigest()
            self.data = data
            with self.subTest(data=data[:20]), patch.object(sync, "urlopen", side_effect=self.responses()), patch.object(sync, "gh") as gh:
                with self.assertRaises(ValueError):
                    sync.sync_release(self.release, ADDON_ID)
                gh.assert_not_called()

    def test_drafts_nonversion_tags_and_missing_assets_are_skipped(self):
        for release in (dict(self.release, draft=True), dict(self.release, tag_name="latest"),
                        dict(self.release, assets=[])):
            with patch.object(sync, "urlopen") as request, patch.object(sync, "gh") as gh:
                sync.sync_release(release, ADDON_ID)
                request.assert_not_called()
                gh.assert_not_called()

    def test_wrong_version_hash_or_download_host_is_rejected(self):
        for field, value in (("version", "2.0.0"), ("hash", "sha256:bad"),
                             ("url", "https://example.com/addon.xpi")):
            self.setUp()
            (self.approved if field == "version" else self.approved["file"])[field] = value
            with self.subTest(field=field), patch.object(sync, "urlopen", side_effect=self.responses()) as request, patch.object(sync, "gh") as gh:
                with self.assertRaises(ValueError):
                    sync.sync_release(self.release, ADDON_ID)
                self.assertEqual(request.call_count, 1)
                gh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
