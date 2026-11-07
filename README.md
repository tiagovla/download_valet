# Download Valet

Sort downloads into folders by file type. Requires Firefox 142+ or Chrome 102+.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select this project's `manifest.json`.
3. Open Download Valet from the extensions menu to edit your rules.

Temporary add-ons are removed when Firefox closes. Permanent installation requires Mozilla signing.

## Load in Chrome

1. Build the packages using the instructions below.
2. Extract `dist/download-valet-1.0.0-chrome.zip` into a folder.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder.

## Run tests

Requires Node.js 18+ and Python 3. No dependency installation is needed.

```sh
npm test
```

## Build

Requires Python 3. Run:

```sh
npm run package
```

Generates both packages in `dist/`:

- Firefox: `download-valet-1.0.0.xpi` (unsigned).
- Chrome: `download-valet-1.0.0-chrome.zip`.
