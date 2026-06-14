# HTML to NDI Converter

> **Disclaimer:** This app is fully vibecoded and is provided as-is, without warranty. Review, test, and validate it thoroughly before relying on it in a production environment.

A Windows tool for media production and live streaming that renders a live web page (an "HTML stream") and publishes it on the network as an **NDI** video source. Point it at any URL and it appears as an NDI input in vMix, OBS (with the NDI plugin), TriCaster, Wirecast, and other NDI-aware software.

It supports a transparent background, so pages with alpha render as a true NDI source **with an alpha channel**, ideal for overlays and lower-thirds.

## How it works

```
 Website (HTML/CSS/JS)
        │
        ▼
 Electron (Chromium) offscreen renderer   ← renders the page at your fps
        │  BGRA frames
        ▼
 Native NDI sender addon (NDI 6 SDK)       ← C++ / N-API
        │
        ▼
 NDI source on the LAN  →  vMix / OBS / TriCaster / ...
```

- **Rendering:** Electron's offscreen mode produces a real Chromium render of the page (full JS, CSS animations, WebGL via software) as BGRA pixel buffers.
- **NDI output:** A small custom C++ N-API addon (`native/ndi_sender.cc`) wraps the official NDI SDK `NDIlib_send_*` API and transmits each frame. (The common Node NDI binding _grandiose_ only **receives** NDI, so sending is implemented here directly.)

## Requirements

You can **build on one PC and run on another** (recommended for a vMix machine). The two roles have different requirements.

### Build machine (developer PC)

Must be **Windows x64** — the native addon links against the Windows NDI SDK and cannot be cross-compiled from macOS/Linux. Install one-time:

1. **Node.js 22 LTS or newer (x64)** — https://nodejs.org
2. **Visual Studio Build Tools** with the **"Desktop development with C++"**
   workload — https://visualstudio.microsoft.com/downloads/
   (needed to compile the native addon)
3. **NDI 6 SDK** — https://ndi.video/for-developers/ndi-sdk/
   Default install path: `C:\Program Files\NDI\NDI 6 SDK`
   If you install it elsewhere, set an environment variable `NDI_SDK_DIR` pointing to the SDK root before building.


### Production / vMix machine

Does **not** need Node.js, the build tools, or the NDI SDK — the packaged app bundles its own Electron/Node runtime. It only needs:

1. **NDI 6 Runtime / Tools** — https://ndi.video/tools/
   Provides `Processing.NDI.Lib.x64.dll` at runtime and the free NDI Studio
   Monitor for testing.
2. **Microsoft Visual C++ Redistributable (x64)** — usually already present; install it if NDI fails to initialize.

> The NDI runtime DLL must be reachable at runtime. The NDI Tools installer adds it to the system. If NDI fails to initialize, copy `Processing.NDI.Lib.x64.dll` (from `NDI 6 SDK\Bin\x64`) next to the app executable.

> Build and run must use the same architecture (**x64**), which is the default.

## Setup & build

From the project folder:

```
powershell
npm install          # installs Electron and builds the native addon
```

`npm install` runs the `postinstall` step which compiles `native/ndi_sender.cc` against the installed Electron headers and produces `build/Release/ndi_sender.node`.

If you ever need to rebuild the addon manually:

```
powershell
npm run build:native
```

## Configure

Edit `config.json`:

| Field                                         | Meaning                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `url`                                         | The web page to render and stream.                                                   |
| `ndiName`                                     | Name the NDI source appears as on the network.                                       |
| `width`, `height`                             | Output resolution in pixels (e.g. 1920 x 1080).                                      |
| `fps`                                         | Render/output frame rate (1–60).                                                     |
| `frameRateNumerator` / `frameRateDenominator` | NDI frame rate metadata. 60000/1000 = 60p, 30000/1001 = 29.97p, 60000/1001 = 59.94p. |
| `transparent`                                 | `true` to output an alpha channel (for overlays).                                    |
| `disableHardwareAcceleration`                 | Keep `true` for reliable CPU frame capture.                                          |
| `reloadOnFailureSeconds`                      | Auto-reload delay if the page crashes or fails to load.                              |

You can also point the app at a different config file with the `HTML2NDI_CONFIG` environment variable.

## Run (development)

```
powershell
npm start
```

Open **NDI Studio Monitor** (from NDI Tools) and you should see a source named after `ndiName`.

## Package as a standalone app

```
powershell
npm run dist
```

This produces an installer/executable in `dist\` (via electron-builder). The default `config.json` is bundled next to the executable so you can edit it on the target machine without rebuilding.

## Deploy to the vMix machine

Build on the developer PC, then copy the result to the vMix PC — Node.js and the build tools are **not** needed on the vMix PC.

1. On the build PC: `npm run dist`.
2. Copy the installer from `dist\` (e.g. `HTMLtoNDI Setup x.y.z.exe`) to the vMix PC and run it — or copy the whole `dist\win-unpacked\` folder.
3. Ensure the **NDI Runtime** (NDI Tools) is installed on the vMix PC.
4. Edit `config.json` next to the executable for that machine's URL/resolution.
5. Test by launching the app and confirming the source appears in NDI Studio Monitor, then set up autostart (below).

## Continuous builds / Releases

A GitHub Actions workflow (`.github/workflows/build-and-release.yml`) compiles
the native addon and packages the Windows installer automatically.

Because the NDI SDK license forbids republishing the SDK in a public repo, the
SDK is committed **encrypted** as `vendor/ndi-sdk.enc` and decrypted in CI with
a passphrase.

The encrypted blob is **already committed** to this repo. The only required
setup is to add the matching passphrase as a repository secret:

- **Settings → Secrets and variables → Actions → New repository secret**
- Name: `NDI_SDK_KEY`
- Value: the passphrase that was used to encrypt `vendor/ndi-sdk.enc`

> Updating the SDK later? Re-encrypt and commit the new blob (full steps in
> [`vendor/README.txt`](vendor/README.txt)):
>
> ```powershell
> $env:NDI_SDK_KEY = "your-passphrase"
> node scripts/crypt-ndi.js encrypt .\ndi-stage vendor/ndi-sdk.enc
> git add vendor/ndi-sdk.enc; git commit -m "Update encrypted NDI SDK"
> ```

The workflow decrypts the SDK, builds the addon, bundles the runtime DLL next
to the packaged `.exe`, and then:

- **Publish a release:** push a version tag and the workflow builds the
  installer and attaches it to a new GitHub Release.

  ```powershell
  npm version patch      # bumps version and creates a git tag
  git push --follow-tags
  ```

  (Or create the tag manually, e.g. `git tag v1.0.0 && git push origin v1.0.0`.)

- **Just build:** trigger the workflow manually from the **Actions** tab
  (_Run workflow_). The installer is uploaded as a downloadable build artifact.

> To build or package locally, decrypt first:
> `node scripts/crypt-ndi.js decrypt vendor/ndi-sdk.enc vendor/ndi`
> (with `NDI_SDK_KEY` set), then run `npm run build:native` / `npm run dist`.

## Autostart on boot

The app needs an interactive desktop session, so it is started at **user logon**. On a dedicated production PC, enable automatic logon for the production user (Windows `netplwiz` / autologon), then register the task:

```
powershell
# Run in an elevated PowerShell prompt, from the project folder:
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

This creates a Scheduled Task `HtmlToNdiConverter` that:

- runs at logon of the current user,
- runs with highest privileges,
- restarts automatically (every minute, effectively forever) if it stops.

The installer auto-detects a packaged build (`dist\win-unpacked\HTMLtoNDI.exe` or the installed location). To target a specific executable:

```
powershell
.\scripts\install-autostart.ps1 -ExePath "C:\Path\To\HTMLtoNDI.exe"
```

Start it immediately without rebooting:

```
powershell
Start-ScheduledTask -TaskName "HtmlToNdiConverter"
```

Remove autostart:

```
powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
```

## Troubleshooting

- **NDI source doesn't appear:** Confirm the NDI Runtime/Tools are installed and that the source machine and receiver are on the same network/VLAN with mDNS allowed. Test with NDI Studio Monitor on the same PC first.
- **`NDIlib_initialize() failed`:** The NDI runtime DLL is missing. Install NDI Tools or copy `Processing.NDI.Lib.x64.dll` next to the executable.
- **Native build fails:** Ensure the C++ Build Tools workload is installed and the NDI 6 SDK exists at `C:\Program Files\NDI\NDI 6 SDK` (or set
  `NDI_SDK_DIR`).
- **Black frame / nothing renders:** Some pages require a real GPU. Keep `disableHardwareAcceleration: true`; if a page still misbehaves, try a lower `fps`.
- **High CPU:** Software rendering at 1080p60 is CPU-intensive. Lower the `fps` or `height`/`width`, or run on a machine with more cores.

## Alternative (no-code) option

If you prefer not to build/maintain a tool, the same result can be achieved with **OBS Studio** + a **Browser Source** + the **DistroAV (obs-ndi)** plugin, which outputs the OBS program/source as NDI. This project exists for a lightweight, headless, single-purpose, auto-starting converter without a full OBS install.

## License

MIT. NDI® is a registered trademark of Vizrt NDI AB. This project uses the NDI
SDK under NewTek/Vizrt's license; install the SDK separately.
