#!/usr/bin/env node
/**
 * Remove YouTube rolling-caption top lines from SRT cues.
 *
 * Rule:
 * - If a cue has 2+ non-empty content lines and its first content line equals
 *   the previous cue's last content line, remove that first line.
 * - If a cue has only 1 non-empty content line, keep it.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SUBTITLES_DIR = "./subtitles/";

const TIMESTAMP_RE =
  /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;

function parseSubtitles(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/));
}

function formatSubtitles(blocks) {
  return blocks.map((lines) => lines.join("\n")).join("\n\n");
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

export async function removeRollingSubtitles() {
  // Read all SRT files from the subtitles directory
  const files = await readdir(SUBTITLES_DIR);
  const srtFiles = files.filter(file => file.endsWith('.srt'));
  
  console.log(`Processing ${srtFiles.length} subtitle files...`);
  
  let totalRemovedLines = 0;
  let totalCuesProcessed = 0;
  
  for (const filename of srtFiles) {
    const inputPath = join(SUBTITLES_DIR, filename);
    
    try {
      const source = await readFile(inputPath, "utf8");
      const blocks = parseSubtitles(source);

      let previousCueLastLine = "";
      let removedLines = 0;

      const updatedBlocks = blocks.map((lines) => {
        const timestampLineIndex = findTimestampLineIndex(lines);

        if (timestampLineIndex === -1) {
          return lines;
        }

        const contentStartIndex = timestampLineIndex + 1;
        const contentIndices = getNonEmptyContentIndices(lines, contentStartIndex);

        // Keep single-line cues as-is.
        if (contentIndices.length <= 1) {
          const lastLine = getLastNonEmptyContentLine(lines, contentStartIndex);
          if (lastLine !== "") {
            previousCueLastLine = lastLine;
          }
          return lines;
        }

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

        return nextLines;
      });

      const output = formatSubtitles(updatedBlocks);
      await writeFile(inputPath, output, "utf8");

      totalRemovedLines += removedLines;
      totalCuesProcessed += blocks.length;
      
      console.log(`Processed: ${filename} - Removed ${removedLines} lines`);
    } catch (error) {
      console.error(`Error processing ${filename}:`, error.message);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Total cues processed: ${totalCuesProcessed}`);
  console.log(`Total top lines removed: ${totalRemovedLines}`);
  console.log("Processing complete!");
}

removeRollingSubtitles().catch((error) => {
  console.error(error);
  process.exit(1);
});
