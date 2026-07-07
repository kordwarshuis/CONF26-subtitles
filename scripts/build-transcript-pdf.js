#!/usr/bin/env node
/**
 * Build a beautifully designed PDF containing every edited transcript
 * from the KERI Conference 2026 subtitle files.
 *
 * Pipeline:
 *   1. Read all `*.fixed.srt` files from ./subtitles/
 *   2. Parse SRT cues and group them into readable paragraphs
 *   3. Render an HTML document with a cover page, table of contents,
 *      and one chapter per talk
 *   4. Drive the locally installed Google Chrome (via puppeteer-core)
 *      to print the HTML to a paged PDF
 *
 * Usage:
 *   node scripts/build-transcript-pdf.js [--open]
 *
 * Output:
 *   KERI-Conference-2026-Transcripts.pdf  (in the repo root)
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUBTITLES_DIR = join(ROOT, "subtitles");
const OUTPUT_PATH = join(ROOT, "KERI-Conference-2026-Transcripts.pdf");

const BOM = "\uFEFF";
const TIMESTAMP_RE = /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/;
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// ─── SRT parsing ────────────────────────────────────────────────────────────

function parseSrt(text) {
  const stripped = text.startsWith(BOM) ? text.slice(1) : text;
  return stripped
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/))
    .map((lines) => {
      const tsIdx = lines.findIndex((l) => TIMESTAMP_RE.test(l));
      if (tsIdx === -1) return null;
      const match = lines[tsIdx].match(TIMESTAMP_RE);
      const content = lines
        .slice(tsIdx + 1)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        start: toSeconds(match[1]),
        end: toSeconds(match[2]),
        text: content,
      };
    })
    .filter(Boolean);
}

function toSeconds(ts) {
  const [h, m, rest] = ts.split(":");
  const [s, ms] = rest.split(",");
  return (+h * 3600 + +m * 60 + +s) + +ms / 1000;
}

function formatTimestamp(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ─── Filename → metadata ────────────────────────────────────────────────────

const SEP = "｜"; // fullwidth vertical line used in filenames
const TITLE_SUFFIX = "｜ KERI Conference 2026";

function parseFilename(filename) {
  // Strip extension + the trailing "｜ KERI Conference 2026" token
  const base = filename.replace(/\.fixed\.srt$/i, "").replace(/\.srt$/i, "");
  let core = base;
  // Match the conference tag with either fullwidth or ascii pipe, case-insensitive
  const tagRe = /\s*[｜|]\s*KERI\s*Conf(?:erence)?\s*2026\s*$/i;
  const tagMatch = base.match(tagRe);
  if (tagMatch) core = base.slice(0, tagMatch.index);

  const parts = core.split(SEP).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { speaker: parts[0], title: parts.slice(1).join(` ${SEP} `).trim() };
  }
  return { speaker: "", title: core.trim() };
}

// ─── Cue → paragraph grouping ───────────────────────────────────────────────

const SENTENCE_END = /[.!?]["'”’)\]]?$/;
const FILLER = /^\s*[\[(](?:inaudible|applause|laughter|music|silence|indistinct|cross ?talk)[^\])]*[\])]\s*$/i;

function groupIntoParagraphs(cues) {
  // Drop the opening title cue (the talk's own title slide) and bracketed
  // non-speech markers, then flow the remaining text into readable paragraphs.
  const cleaned = cues
    .filter((c, i) => !(i === 0 && c.text.length > 0 && c.end - c.start < 4))
    .filter((c) => c.text.length > 0)
    .filter((c) => !FILLER.test(c.text));

  const paragraphs = [];
  let current = null;

  const flush = () => {
    if (current && current.text.trim()) {
      current.text = current.text.replace(/\s+/g, " ").trim();
      paragraphs.push(current);
    }
    current = null;
  };

  for (const cue of cleaned) {
    if (!current) {
      current = { start: cue.start, text: cue.text };
      continue;
    }

    const gap = cue.start - current.start;
    const endsSentence = SENTENCE_END.test(current.text);
    const longEnough = current.text.length >= 80;

    if ((endsSentence && longEnough) || gap > 6) {
      flush();
      current = { start: cue.start, text: cue.text };
    } else {
      const needsSpace = !current.text.endsWith(" ") && !cue.text.startsWith(" ");
      current.text += (needsSpace ? " " : "") + cue.text;
    }
  }
  flush();

  return paragraphs;
}

// ─── HTML escaping ──────────────────────────────────────────────────────────

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const romanNumerals = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
  "XXI", "XXII", "XXIII", "XXIV", "XXV", "XXVI", "XXVII", "XXVIII", "XXIX", "XXX",
];
function toRoman(n) {
  return romanNumerals[n - 1] ?? String(n);
}

function initialOf(speaker) {
  const parts = speaker.split(/\s+/).filter(Boolean);
  return parts.length ? parts[0][0].toUpperCase() : "•";
}

// ─── HTML assembly ──────────────────────────────────────────────────────────

function buildHtml(talks, generatedOn) {
  const talkRows = talks
    .map((t, i) => {
      const num = String(i + 1).padStart(2, "0");
      return `
        <a class="toc-row" href="#talk-${i}">
          <span class="toc-num">${num}</span>
          <span class="toc-speaker">${esc(t.speaker)}</span>
          <span class="toc-title">${esc(t.title)}</span>
          <span class="toc-dots"></span>
          <span class="toc-page-no">${formatTimestamp(t.duration)}</span>
        </a>`;
    })
    .join("");

  const chapters = talks
    .map((t, i) => {
      const paragraphs = t.paragraphs
        .map(
          (p) =>
            `<p><span class="ts">${formatTimestamp(p.start)}</span>${esc(p.text)}</p>`
        )
        .join("\n");

      return `
      <section class="chapter">
        <div class="chapter-opener">
          <div class="chapter-opener-inner">
            <div class="chapter-mark">Talk ${toRoman(i + 1)}</div>
            <div class="chapter-initial">${esc(initialOf(t.speaker))}</div>
            <h1 class="chapter-title">${esc(t.title)}</h1>
            <div class="chapter-speaker">${esc(t.speaker)}</div>
            <div class="chapter-meta">KERI Conference 2026 · ${formatTimestamp(t.duration)}</div>
          </div>
        </div>
        <div class="transcript" id="talk-${i}">
          ${paragraphs}
        </div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KERI Conference 2026 — Transcripts</title>
<style>
  @page {
    size: A4;
    margin: 22mm 18mm 20mm 18mm;
    @bottom-left {
      content: "KERI Conference 2026";
      font-family: "Iowan Old Style", "Palatino", Georgia, serif;
      font-size: 8.5pt;
      color: #8a8f98;
    }
    @bottom-right {
      content: counter(page);
      font-family: "Iowan Old Style", "Palatino", Georgia, serif;
      font-size: 8.5pt;
      color: #8a8f98;
    }
  }
  @page cover { margin: 0; @bottom-left { content: ""; } @bottom-right { content: ""; } }
  @page opener { margin: 0; @bottom-left { content: ""; } @bottom-right { content: ""; } }
  @page toc { @bottom-right { content: counter(page); } }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino", "Palatino Linotype", Georgia, serif;
    color: #1b1f24;
    font-size: 10.5pt;
    line-height: 1.55;
    text-rendering: optimizeLegibility;
  }

  /* ─── Cover ─── */
  .cover {
    page: cover;
    page-break-after: always;
    position: relative;
    height: 297mm;
    box-sizing: border-box;
    padding: 0;
    background:
      radial-gradient(120% 80% at 85% 8%, rgba(120, 190, 255, 0.18), transparent 60%),
      radial-gradient(90% 70% at 10% 95%, rgba(255, 180, 120, 0.10), transparent 55%),
      linear-gradient(160deg, #0b1f3a 0%, #112a52 45%, #0a1730 100%);
    color: #f4f6fb;
    overflow: hidden;
  }
  .cover::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
    background-size: 28mm 28mm;
    pointer-events: none;
  }
  .cover-inner {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 28mm 22mm;
  }
  .cover-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .cover-mark {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 9pt;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: #7fb6ff;
  }
  .cover-glyph {
    width: 14mm; height: 14mm;
    border: 1.5px solid rgba(255,255,255,0.45);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: "Iowan Old Style", Georgia, serif;
    font-size: 16pt; font-style: italic; color: #fff;
  }
  .cover-center { margin-top: -8mm; }
  .cover-eyebrow {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 10pt;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    color: #9fc7ff;
    margin-bottom: 14mm;
  }
  .cover-title {
    font-family: "Iowan Old Style", "Palatino", Georgia, serif;
    font-weight: 700;
    font-size: 64pt;
    line-height: 1.02;
    letter-spacing: -0.01em;
    margin: 0;
  }
  .cover-title .accent { color: #7fb6ff; font-style: italic; font-weight: 400; }
  .cover-sub {
    margin-top: 10mm;
    font-size: 16pt;
    font-style: italic;
    color: #c9d6ee;
    max-width: 130mm;
    line-height: 1.4;
  }
  .cover-rule {
    margin-top: 14mm;
    width: 60mm;
    height: 1px;
    background: linear-gradient(90deg, #7fb6ff, transparent);
  }
  .cover-bottom {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 9pt;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #aab9d6;
  }
  .cover-bottom .stats { display: flex; gap: 14mm; }
  .cover-bottom .stat-num {
    display: block;
    font-family: "Iowan Old Style", Georgia, serif;
    font-size: 22pt;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
    color: #fff;
    margin-bottom: 2mm;
  }

  /* ─── Table of contents ─── */
  .toc-page { page: toc; page-break-after: always; }
  .toc-heading {
    font-family: "Iowan Old Style", Georgia, serif;
    font-size: 30pt;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0 0 2mm 0;
  }
  .toc-lede {
    font-style: italic;
    color: #5a6270;
    margin: 0 0 10mm 0;
    font-size: 11pt;
  }
  .toc-list { display: flex; flex-direction: column; }
  .toc-row {
    display: grid;
    grid-template-columns: 10mm 38mm 1fr auto;
    align-items: baseline;
    gap: 3mm;
    padding: 2.2mm 0;
    border-bottom: 0.5px solid #e4e7ec;
    text-decoration: none;
    color: inherit;
  }
  .toc-num {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 9pt;
    color: #9aa3b0;
  }
  .toc-speaker {
    font-weight: 700;
    font-size: 10.5pt;
  }
  .toc-title {
    font-style: italic;
    color: #444b56;
    font-size: 10.5pt;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toc-dots { display: none; }
  .toc-page-no {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 9pt;
    color: #9aa3b0;
    text-align: right;
    min-width: 16mm;
  }

  /* ─── Chapter opener ─── */
  .chapter { page-break-before: always; }
  .chapter-opener {
    page: opener;
    page-break-after: always;
    height: 257mm;
    box-sizing: border-box;
    background: linear-gradient(165deg, #0b1f3a 0%, #112a52 100%);
    color: #f4f6fb;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .chapter-opener::before {
    content: "";
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 24mm 24mm;
  }
  .chapter-opener-inner {
    position: relative;
    text-align: center;
    padding: 0 30mm;
  }
  .chapter-mark {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 10pt;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    color: #7fb6ff;
    margin-bottom: 18mm;
  }
  .chapter-initial {
    width: 26mm; height: 26mm;
    margin: 0 auto 14mm;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: "Iowan Old Style", Georgia, serif;
    font-style: italic;
    font-size: 30pt;
    color: #fff;
  }
  .chapter-title {
    font-family: "Iowan Old Style", Georgia, serif;
    font-weight: 700;
    font-size: 30pt;
    line-height: 1.15;
    letter-spacing: -0.01em;
    margin: 0 auto 10mm;
    max-width: 150mm;
  }
  .chapter-speaker {
    font-size: 15pt;
    font-style: italic;
    color: #c9d6ee;
    margin-bottom: 6mm;
  }
  .chapter-meta {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 9pt;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #9fc7ff;
  }

  /* ─── Transcript body ─── */
  .transcript { columns: 1; }
  .transcript p {
    margin: 0 0 2.8mm 0;
    text-indent: 0;
    orphans: 3;
    widows: 3;
    text-align: justify;
    hyphens: auto;
  }
  .transcript p .ts {
    display: inline-block;
    min-width: 14mm;
    margin-right: 3mm;
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 7.5pt;
    color: #b89058;
    letter-spacing: 0.04em;
    vertical-align: baseline;
  }

  /* First paragraph after opener: drop cap */
  .transcript p:first-child::first-letter {
    font-family: "Iowan Old Style", Georgia, serif;
    font-size: 32pt;
    font-weight: 700;
    float: left;
    line-height: 0.9;
    padding: 1.5mm 2mm 0 0;
    color: #0b1f3a;
  }
</style>
</head>
<body>

  <div class="cover">
    <div class="cover-inner">
      <div class="cover-top">
        <div class="cover-mark">KERI · 2026</div>
        <div class="cover-glyph">K</div>
      </div>
      <div class="cover-center">
        <div class="cover-eyebrow">Conference Proceedings</div>
        <h1 class="cover-title">KERI<br>Conference<br><span class="accent">2026</span></h1>
        <div class="cover-sub">A complete transcript of every talk from the KERI Conference 2026 — the language of autonomous, verifiable identity.</div>
        <div class="cover-rule"></div>
      </div>
      <div class="cover-bottom">
        <div class="stats">
          <div><span class="stat-num">${talks.length}</span>Talks</div>
          <div><span class="stat-num">${formatTimestamp(
            talks.reduce((a, t) => a + t.duration, 0)
          )}</span>Runtime</div>
        </div>
        <div>${generatedOn}</div>
      </div>
    </div>
  </div>

  <div class="toc-page">
    <h2 class="toc-heading">Contents</h2>
    <p class="toc-lede">Full transcripts of all ${talks.length} recorded sessions, in the order they appear in the archive.</p>
    <div class="toc-list">${talkRows}</div>
  </div>

  ${chapters}

</body>
</html>`;
}

// ─── Chrome discovery ───────────────────────────────────────────────────────

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "Could not find Google Chrome / Chromium / Edge. Install Chrome or add its path to CHROME_CANDIDATES."
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const openAfter = process.argv.includes("--open");

  const files = await readdir(SUBTITLES_DIR);
  const srtFiles = files
    .filter((f) => /\.fixed\.srt$/i.test(f))
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  if (srtFiles.length === 0) {
    console.error("No .fixed.srt files found in", SUBTITLES_DIR);
    process.exit(1);
  }

  console.log(`Found ${srtFiles.length} transcript files.`);

  const talks = [];
  for (const filename of srtFiles) {
    const path = join(SUBTITLES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const cues = parseSrt(raw);
    const { speaker, title } = parseFilename(filename);
    const paragraphs = groupIntoParagraphs(cues);
    const duration = cues.length ? cues[cues.length - 1].end : 0;
    talks.push({ filename, speaker, title, paragraphs, duration });
    console.log(
      `  · ${speaker.padEnd(28)} ${title.slice(0, 50).padEnd(50)} ${formatTimestamp(duration)}`
    );
  }

  const generatedOn = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  const html = buildHtml(talks, generatedOn);
  const htmlPath = join(ROOT, ".transcripts-build.html");
  await writeFile(htmlPath, html, "utf8");
  console.log(`Wrote intermediate HTML: ${htmlPath}`);

  console.log("Launching Chrome to render PDF…");
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: "new",
    userDataDir: join(ROOT, ".chrome-profile"),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    await page.pdf({
      path: OUTPUT_PATH,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await browser.close();
  }

  console.log(`\n✓ PDF written: ${OUTPUT_PATH}`);
  if (openAfter) {
    const { exec } = await import("node:child_process");
    exec(`open "${OUTPUT_PATH}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
