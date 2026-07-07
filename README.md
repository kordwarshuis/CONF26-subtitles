# KERI Conference 2026 Subtitles

## General info

This repository contains automatically generated subtitle files for the video recordings of the KERI Conference 2026.

These subtitles are being manually edited here.

## Tools

Subtitle Edit is a good tool for creating or editing subtitles.

https://subtitleedit.github.io/subtitleedit/

https://github.com/SubtitleEdit

## Scripts

- `scripts/remove-rolling-subtitles.js` — cleans YouTube rolling-caption artefacts from the `.srt` files in `subtitles/`.
- `scripts/build-transcript-pdf.js` — assembles every `*.fixed.srt` file into a beautifully designed PDF book of transcripts.

### Building the transcripts PDF

```bash
npm install
npm run build:pdf        # writes KERI-Conference-2026-Transcripts.pdf to the repo root
npm run build:pdf -- --open   # build and open in the default viewer
```

The PDF is rendered by the locally installed Google Chrome via `puppeteer-core`
(no Chromium download required). On macOS it auto-detects Chrome at
`/Applications/Google Chrome.app`; on Linux set the path in
`CHROME_CANDIDATES` inside the script.

The generated PDF includes:

- A full-bleed cover page
- A table of contents listing all talks with runtimes
- One chapter per talk with a dark opener page and a flowing, timestamped transcript body
