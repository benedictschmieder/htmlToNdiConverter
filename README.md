# HTML to NDI Converter

> [!WARNING]
> **Disclaimer:** This app is fully vibecoded and provided as-is without warranty. Review and test it before relying on it in production.

A Windows tool for media production and live streaming that renders a live web page and publishes it on the network as an **NDI** video source. Point it at any URL and it appears as an NDI input in NDI-aware software. Pages with a transparent background output a true alpha channel, ideal for overlays and lower-thirds.

## How to use

You only need the installer (`HTMLtoNDI Setup x.y.z.exe`) from the [Releases page](../../releases) and the free [NDI Tools / Runtime](https://ndi.video/tools/).

**1. Install the NDI Runtime** (one-time, per machine) from https://ndi.video/tools/. This provides the NDI discovery service used by NDI receivers.

**2. Run the installer.** It's a one-click per-user installer (no admin needed) and launches automatically. It installs to `C:\Users\<you>\AppData\Local\Programs\HTMLtoNDI\`, with `HTMLtoNDI.exe` and `config.json` side by side in that folder.

**3. Configure** by editing `config.json` next to the exe, then restart the app:

| Field                                         | Meaning                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `url`                                         | The web page to render and stream. **The main thing to set.**                                     |
| `ndiName`                                     | Source name shown in your NDI receiver's source list (e.g. "Scoreboard").                         |
| `width`, `height`                             | Output resolution in pixels.                                                                      |
| `fps`                                         | Frame rate, 1–60.                                                                                 |
| `frameRateNumerator` / `frameRateDenominator` | NDI frame-rate metadata. 60000/1000 = 60p, 30000/1001 = 29.97p, 60000/1001 = 59.94p.              |
| `transparent`                                 | `true` to output an alpha channel for keyable overlays (the page background must be transparent). |
| `disableHardwareAcceleration`                 | Keep `true` for reliable CPU frame capture.                                                       |
| `reloadOnFailureSeconds`                      | Auto-reload delay if the page crashes or fails to load.                                           |

**4. Use it in your NDI receiver** (vMix, OBS with the NDI plugin, TriCaster, Wirecast, etc.) by adding an NDI input and picking the source named after your `ndiName`. (Test first with NDI Studio Monitor from NDI Tools.)

**5. Check status & logs.** The app runs in the background with a **system-tray icon**. Right-click it to see the live status (Streaming / Loading / Error), open `config.json`, or open the log file. The log is the first place to look if no NDI source appears — it records the URL, resolution, page load result, and any NDI errors.

**6. Autostart on boot (optional)** so it runs unattended. Enable automatic Windows logon for the production user, then run this once in an elevated PowerShell from the project folder. It registers a scheduled task `HtmlToNdiConverter` that launches at logon and auto-restarts on crash.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

Target a specific exe with `-ExePath "C:\Path\To\HTMLtoNDI.exe"`, start it now with `Start-ScheduledTask -TaskName "HtmlToNdiConverter"`, or remove it with `uninstall-autostart.ps1`.

## How it works

Electron's offscreen Chromium mode renders the page (full JS, CSS, WebGL) into BGRA frames at your chosen fps. A small custom C++ N-API addon ([`native/ndi_sender.cc`](native/ndi_sender.cc)) wraps the official NDI 6 SDK `NDIlib_send_*` API and transmits each frame on the LAN. (The common Node binding _grandiose_ only **receives** NDI, so sending is implemented here directly.)

## Building from source

You can build on one Windows PC and run on another — the production PC needs nothing but the NDI Runtime above.

The **build machine** must be **Windows x64** (the native addon links against the Windows NDI SDK and can't be cross-compiled) with: [Node.js 22 LTS or newer (x64)](https://nodejs.org), [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload, and the [NDI 6 SDK](https://ndi.video/for-developers/ndi-sdk/) (default path `C:\Program Files\NDI\NDI 6 SDK`; set `NDI_SDK_DIR` if installed elsewhere).

```powershell
npm install        # installs Electron and builds the native addon
npm start          # run in development
npm run dist       # package the Windows installer into dist\
```

`npm install` compiles `native/ndi_sender.cc` against the Electron headers via the `install` script. Rebuild the addon alone with `npm run build:native`.

## Releases (CI)

The GitHub Actions workflow ([`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml)) compiles the addon and packages the installer automatically. Because the NDI SDK license forbids republishing it, the SDK is committed **encrypted** as `vendor/ndi-sdk.enc` and decrypted in CI. The blob is already committed — the only setup is adding a repository secret **`NDI_SDK_KEY`** (Settings → Secrets and variables → Actions) with the passphrase used to encrypt it.

Push a version tag to build and publish a GitHub Release with the installer attached:

```powershell
npm version patch
git push --follow-tags
```

Or run the workflow manually from the **Actions** tab to get the installer as a build artifact. To update the SDK, or to build locally, see [`vendor/README.txt`](vendor/README.txt).

## Troubleshooting

- **NDI source doesn't appear:** Confirm the NDI Runtime is installed and that both machines are on the same network/VLAN with mDNS allowed; test with NDI Studio Monitor on the source PC first. If discovery is blocked, add the machine manually in NDI Access Manager.
- **`NDIlib_initialize() failed`:** The NDI runtime DLL is missing — install NDI Tools or copy `Processing.NDI.Lib.x64.dll` next to the exe.
- **Source shows defaults (example.com):** `config.json` has a typo and silently fell back to defaults; validate the JSON.
- **Native build fails:** Ensure the C++ Build Tools workload is installed and the NDI 6 SDK exists (or set `NDI_SDK_DIR`).
- **Black frame / high CPU:** Software rendering at 1080p60 is CPU-heavy; lower `fps`, `width`, or `height`.

## Alternative (no-code)

The same result is possible with **OBS Studio** + a **Browser Source** + the **DistroAV (obs-ndi)** plugin. This project exists as a lightweight, headless, single-purpose, auto-starting converter without a full OBS install.

## License

MIT. NDI® is a registered trademark of Vizrt NDI AB. This project uses the NDI SDK under NewTek/Vizrt's license; install the SDK separately.
