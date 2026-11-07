"""Replace GitHub release XPIs with approved packages from Mozilla's public API."""
import hashlib
import io
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
UNSIGNED_NOTICE = "The Firefox XPI is unsigned; permanent installation requires Mozilla signing."
SIGNED_NOTICE = "The Firefox XPI is signed by Mozilla and supports permanent installation."


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def sync_release(release, addon_id):
    tag = release["tag_name"]
    if release.get("draft") or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        return
    version = tag[1:]
    name = f"download-valet-{version}.xpi"
    asset = next((asset for asset in release["assets"] if asset["name"] == name), None)
    if asset is None:
        return

    url = f"https://addons.mozilla.org/api/v5/addons/addon/{quote(addon_id, safe='')}/versions/{version}/"
    try:
        with urlopen(url, timeout=60) as response:
            approved = json.load(response)
    except HTTPError as error:
        # Non-public add-ons return 401 until their first version is approved.
        if error.code in (401, 404):
            print(f"{tag}: not publicly available on Mozilla yet")
            return
        raise

    file = approved["file"]
    if approved.get("is_disabled") or file["status"] != "public" or approved["channel"] != "listed":
        print(f"{tag}: awaiting Mozilla approval")
        return
    if approved["version"] != version or not re.fullmatch(r"sha256:[a-f0-9]{64}", file["hash"]):
        raise ValueError(f"{tag}: unexpected Mozilla version or hash")

    with tempfile.TemporaryDirectory() as directory:
        if asset.get("digest") != file["hash"]:
            parsed = urlparse(file["url"])
            if parsed.scheme != "https" or parsed.hostname not in ("addons.mozilla.org", "addons.mozilla.net"):
                raise ValueError(f"{tag}: unexpected Mozilla download URL")
            with urlopen(file["url"], timeout=60) as response:
                data = response.read()
            if "sha256:" + hashlib.sha256(data).hexdigest() != file["hash"]:
                raise ValueError(f"{tag}: downloaded XPI hash does not match Mozilla")
            with ZipFile(io.BytesIO(data)) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                if (manifest["version"] != version or
                        manifest["browser_specific_settings"]["gecko"]["id"] != addon_id or
                        not {"META-INF/mozilla.rsa", "META-INF/cose.sig"}.intersection(archive.namelist())):
                    raise ValueError(f"{tag}: XPI identity or signing files do not match")
            path = Path(directory) / name
            path.write_bytes(data)
            gh("release", "upload", tag, str(path), "--clobber")
            print(f"{tag}: uploaded Mozilla-signed XPI")
        else:
            print(f"{tag}: signed XPI already uploaded")

        notes = release.get("body") or ""
        if UNSIGNED_NOTICE in notes:
            path = Path(directory) / "notes.md"
            path.write_text(notes.replace(UNSIGNED_NOTICE, SIGNED_NOTICE))
            gh("release", "edit", tag, "--notes-file", str(path))


def main():
    addon_id = json.loads((ROOT / "manifest.json").read_text())["browser_specific_settings"]["gecko"]["id"]
    pages = json.loads(gh("api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases"))
    for page in pages:
        for release in page:
            sync_release(release, addon_id)


if __name__ == "__main__":
    main()
