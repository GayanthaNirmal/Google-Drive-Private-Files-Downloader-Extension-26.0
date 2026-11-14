
Drive Private Video Downloader


 A Chrome extension that saves Google Drive videos, audio and documents that are shared with you as


---

## Features

- **Videos.** Saves the highest quality stream Drive offers (for example 720p or 1080p) as an `.mp4` file.
- **Audio.** Saves audio files in their real format (`.m4a`, `.mp3`, `.ogg`, `.wav`, `.flac` …). If the original was an `.mp3` and Drive serves a different format, it is converted back to MP3 (192 kbps) in the browser.
- **Documents.** Saves PDFs, Word files, slides and other previewable files as a PDF, one page at a time, in the original paper size (A4, Letter, Legal, slides 16:9 / 4:3 …).
- **Fast, resumable downloads.** Large files are fetched in parallel 512 KB chunks with automatic retries.
- **Pause, resume, cancel and retry** for each download, with a live progress bar.
- **Up to 3 downloads at once.**
- **Sidebar on Drive pages.** The panel sits on the right side of `drive.google.com` and `docs.google.com`. Click the toolbar icon to show or hide it.
- **Per-tab on/off switch.** Nothing is captured until you press **Turn on** in that tab.
- **Auto refresh.** If the video stream isn't picked up, the page is refreshed (up to 4 times) until it is found.
- **History.** Your download list is kept between sessions and can be cleared with the trash button.

## Installation

The extension is not on the Chrome Web Store. Load it manually:

1. Download this repository (**Code → Download ZIP**) and extract it, or clone it:
   ```bash
   git clone https://github.com/GayanthaNirmal/Google-Drive-Private-Files-Downloader-Extension-26.0.git
   ```
2. Open `chrome://extensions` in Chrome (or any Chromium browser such as Edge or Brave).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the extracted folder (the folder that contains `manifest.json`).
5. Pin the extension to the toolbar so the icon is easy to reach.

## How to use

### Video or audio

1. Open the file on Google Drive (`https://drive.google.com/file/d/…`).
2. In the sidebar, press **Turn on**.
3. Play the video or audio. It appears in the **Downloads** list.
4. Press **Download ↓**. The file is saved to your normal Downloads folder.

> If the video doesn't show up, play it again or press **↻** to refresh the Drive page.

### Documents (PDF, DOCX, PPTX …)

1. Open the file on Google Drive and wait until the whole document has loaded.
2. Press **Turn on**, then **Download ↓**.
3. The extension scrolls through the preview and captures every page. **Keep the Drive tab visible and don't scroll it** until it finishes.
4. The result is saved as a `.pdf` file.

### Tips

- Keep the Drive tab open until the download finishes. Closing it stops the download.
- If you see *"Video URL has expired"*, reload the Drive tab and download again.
- Files with no Drive preview (`.zip`, `.rar`, `.exe`, `.apk`, `.iso` …) can't be downloaded.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `debugger` | Reads Drive's network responses to find the video / audio stream address. Chrome shows a *"started debugging this browser"* bar while it is on. |
| `activeTab`, `scripting` | Runs the download code inside the Drive tab, so your own Drive login is used. |
| `downloads` | Saves the finished file. |
| `storage` | Remembers the download list and sidebar state. |
| Host access to `drive.google.com`, `docs.google.com` | The extension only works on these sites. |

Nothing is sent to any server other than Google's. There is no tracking or analytics.

## Project structure

```
├── manifest.json       Extension manifest (Manifest V3)
├── background.js       Service worker: capture, download and PDF logic
├── sidebar.js          Content script: adds the sidebar to Drive / Docs pages
├── popup.html          Sidebar panel UI
├── popup.js            Sidebar panel logic
├── icon.png            Extension icon
└── lib/
    ├── lame.min.js         lamejs MP3 encoder
    └── lamejs-LICENSE.txt  lamejs license note
```

## Disclaimer

This project is for **personal and educational use**. Only download files that you own or have the owner's permission to download. Respect copyright and Google's Terms of Service. The author is not responsible for how the extension is used.

## License

Released under the [MIT License](LICENSE).

`lib/lame.min.js` (lamejs) is a third-party library under the **LGPL**. See [lib/lamejs-LICENSE.txt](lib/lamejs-LICENSE.txt).
