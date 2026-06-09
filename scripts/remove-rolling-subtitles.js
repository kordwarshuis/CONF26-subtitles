#!/usr/bin/env node
/**
 * Remove YouTube rolling-caption artefacts from SRT cues.
 *
 * Rules applied in a single pass:
 * - If a cue has 2+ non-empty content lines and its first content line equals
 *   the previous cue's last content line, remove that first line.
 * - If a cue has exactly 1 non-empty content line and that line equals the
 *   previous cue's last content line, remove the entire cue (rolling echo).
 * Cues are renumbered sequentially after removal.
 *
 * Rolling captions scroll up two to three lines at a time. The top line
 * disappears as a new bottom line appears in sync with the audio. They can
 * be placed at the top, bottom, or about one-third from the bottom of the screen.
 *
 * Pop-on captions appear and disappear in sync with the audio in blocks of 1-3 lines.
 * The captions can be placed almost anywhere on the screen to avoid covering graphics
 * and faces, and to identify speakers.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SUBTITLES_DIR = "./subtitles/";

const TIMESTAMP_RE =
  /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;

// UTF-8 BOM that some tools prepend to SRT files
const BOM = "\uFEFF";

function parseSubtitles(text) {
  const stripped = text.startsWith(BOM) ? text.slice(1) : text;
  return stripped
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/));
}

function formatSubtitles(blocks) {
  let cueNumber = 0;
  return blocks
    .map((lines) => {
      const tsIdx = findTimestampLineIndex(lines);
      if (tsIdx > 0) {
        // Rewrite the cue-number line so numbers stay sequential after removals
        cueNumber += 1;
        const renumbered = [...lines];
        renumbered[tsIdx - 1] = String(cueNumber);
        return renumbered.join("\n");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function normalizeCueLine(line) {
  return line.replace(/\s+/g, " ").trim();
}

function findTimestampLineIndex(lines) {
  return lines.findIndex((line) => TIMESTAMP_RE.test(line));
}

function getNonEmptyContentIndices(lines, contentStartIndex) {
  const indices = [];

  for (let i = contentStartIndex; i < lines.length; i += 1) {
    if (normalizeCueLine(lines[i]) !== "") {
      indices.push(i);
    }
  }

  return indices;
}

function getLastNonEmptyContentLine(lines, contentStartIndex) {
  for (let i = lines.length - 1; i >= contentStartIndex; i -= 1) {
    const normalized = normalizeCueLine(lines[i]);
    if (normalized !== "") {
      return normalized;
    }
  }

  return "";
}

/**
 * Run one deduplication pass over an array of parsed cue blocks.
 * Returns the updated blocks plus counts of what was removed.
 */
function deduplicatePass(blocks) {
  let previousCueLastLine = "";
  let removedLines = 0;
  let removedCues = 0;

  // flatMap allows returning [] to drop an entire cue block
  const updatedBlocks = blocks.flatMap((lines) => {
    const timestampLineIndex = findTimestampLineIndex(lines);

    if (timestampLineIndex === -1) {
      // Orphaned content block — no timestamp header. This arises when a cue
      // contains a blank line in its body, causing parseSubtitles to split it
      // into an empty cue + a headerless content chunk.
      // Update previousCueLastLine so that the next real cue's echo detection
      // still works correctly.
      const lastNonEmpty = lines
        .map(normalizeCueLine)
        .filter(Boolean)
        .at(-1);
      if (lastNonEmpty !== undefined) {
        if (lastNonEmpty === previousCueLastLine) {
          // This orphaned chunk is itself a rolling echo — drop it.
          removedCues += 1;
          return [];
        }
        previousCueLastLine = lastNonEmpty;
      }
      return [lines];
    }

    const contentStartIndex = timestampLineIndex + 1;
    const contentIndices = getNonEmptyContentIndices(lines, contentStartIndex);

    if (contentIndices.length === 0) {
      // Empty cue — keep as-is (no content to inspect)
      return [lines];
    }

    if (contentIndices.length === 1) {
      const singleLine = normalizeCueLine(lines[contentIndices[0]]);
      if (singleLine === previousCueLastLine) {
        // Rolling echo cue — the single content line is a repeat of the
        // previous cue's last line. Remove the entire cue.
        removedCues += 1;
        return [];
      }
      previousCueLastLine = singleLine;
      return [lines];
    }

    // Multi-line cue: remove the first content line if it repeats the
    // previous cue's last line.
    const firstContentIndex = contentIndices[0];
    const firstLine = normalizeCueLine(lines[firstContentIndex]);

    let nextLines = lines;

    if (previousCueLastLine !== "" && firstLine === previousCueLastLine) {
      nextLines = [
        ...lines.slice(0, firstContentIndex),
        ...lines.slice(firstContentIndex + 1),
      ];
      removedLines += 1;
    }

    const lastLine = getLastNonEmptyContentLine(nextLines, contentStartIndex);
    if (lastLine !== "") {
      previousCueLastLine = lastLine;
    }

    return [nextLines];
  });

  return { updatedBlocks, removedLines, removedCues };
}

export async function removeRollingSubtitles() {
  // Read all SRT files from the subtitles directory
  const files = await readdir(SUBTITLES_DIR);
  const srtFiles = files.filter((file) => file.endsWith(".srt"));

  console.log(`Processing ${srtFiles.length} subtitle files...`);

  let totalRemovedLines = 0;
  let totalRemovedCues = 0;
  let totalCuesProcessed = 0;

  for (const filename of srtFiles) {
    const inputPath = join(SUBTITLES_DIR, filename);

    try {
      const source = await readFile(inputPath, "utf8");
      let blocks = parseSubtitles(source);
      const inputCueCount = blocks.length;

      let fileRemovedLines = 0;
      let fileRemovedCues = 0;

      // Iterate until no more artefacts can be removed. Cascading echoes (e.g.
      // a two-line [A][A] reduced to [A] which is itself an echo of the
      // previous cue) may require more than one pass.
      while (true) {
        const { updatedBlocks, removedLines, removedCues } = deduplicatePass(blocks);
        fileRemovedLines += removedLines;
        fileRemovedCues += removedCues;
        blocks = updatedBlocks;
        if (removedLines === 0 && removedCues === 0) break;
      }

      const output = formatSubtitles(blocks);

      if (output === source) {
        console.log(`Skipped (no changes): ${filename}`);
        continue;
      }

      await writeFile(inputPath, output, "utf8");

      totalRemovedLines += fileRemovedLines;
      totalRemovedCues += fileRemovedCues;
      totalCuesProcessed += inputCueCount;

      console.log(
        `Processed: ${filename} — removed ${fileRemovedLines} duplicate lines, ${fileRemovedCues} echo cues`
      );
    } catch (error) {
      console.error(`Error processing ${filename}:`, error.message);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Total input cues processed: ${totalCuesProcessed}`);
  console.log(`Total duplicate first-lines removed: ${totalRemovedLines}`);
  console.log(`Total echo cues removed: ${totalRemovedCues}`);
  console.log("Processing complete!");
}

removeRollingSubtitles().catch((error) => {
  console.error(error);
  process.exit(1);
});
