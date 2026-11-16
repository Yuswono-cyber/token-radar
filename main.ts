// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// copies this repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. A starting
// point, not a winner: it covers the watchlist, states the model and gives every protocol a farm plan.
// Change the model, the page or the plan; keep the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Run `node main.ts --help` for the flags; `node main.ts --version` prints this file's own version.
// The run is one function, main(), that answers with a process exit code: 0 on a complete output, 1 when
// the model's own board check refuses what it built, 2 on a missing snapshot. Every refusal names itself on
// stderr in the scorer's words, so a failed run is read as a gate row rather than a stack trace.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** This entry's own version, printed by --version; the model's version lives in the data.js bundle. */
const ENTRY_VERSION = '1.1.0';

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { min: 3, max: 4, max_bytes: 524_288, long_side: 1440, short_side: 800 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** What --help prints: the flags this file takes and what it does with them. */
function usage(): string {
  return [
    'token radar: builds the ranked board, the dashboard data and the dossier',
    'usage: node main.ts [--input <snapshot.json|directory>] [--output <dir>]',
    '  --input   sealed snapshot; defaults to /input/snapshot.json',
    '  --output  where the files land; defaults to $MAKEFUN_OUTPUT_DIR or /output',
    '  --help    this text, then exit 0',
    '  --version the entry version, then exit 0',
    '',
  ].join('\n');
}

/** A gate row in the scorer's words, written once on stderr; the caller turns it into an exit code. */
function refuse(message: string): number {
  process.stderr.write(`token radar: ${message}\n`);
  return 1;
}

/**
 * The PNG's own pixel size, read from its IHDR chunk, or null when the bytes are not a PNG. The gate
 * measures the same two numbers: the long side at most 1440 pixels, the short side at least 800.
 */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24) return null;
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/**
 * The repository carries each screenshot as base64 text (<name>.png.b64): the channel this
 * entry is submitted through moves text only. Decode each one back to the PNG it names, and refuse
 * the set the way the gate does: a name it will take, 3 to 4 images, each a whole PNG inside 512 KiB
 * with its long side at most 1440 and its short side at least 800 pixels.
 */
function decodeShots(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (!name.endsWith('.png.b64')) continue;
    const pngName = name.slice(0, -'.b64'.length);
    if (!IMAGE_NAME.test(pngName)) throw new Error(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
    const png = Buffer.from(readFileSync(join(from, name), 'utf8').replace(/\s+/g, ''), 'base64');
    if (png.length > SCREENSHOT_CAPS.max_bytes) {
      throw new Error(`screenshots/${pngName}: ${png.length} bytes, over the ${SCREENSHOT_CAPS.max_bytes} a screenshot may carry`);
    }
    const size = pngSize(png);
    if (size === null) throw new Error(`screenshots/${pngName}: not a whole PNG`);
    if (Math.max(size.width, size.height) > SCREENSHOT_CAPS.long_side) {
      throw new Error(`screenshots/${pngName}: ${size.width}x${size.height}, a long side over ${SCREENSHOT_CAPS.long_side} pixels`);
    }
    if (Math.min(size.width, size.height) < SCREENSHOT_CAPS.short_side) {
      throw new Error(`screenshots/${pngName}: ${size.width}x${size.height}, a short side under ${SCREENSHOT_CAPS.short_side} pixels`);
    }
    writeFileSync(join(to, pngName), png);
    names.push(pngName);
  }
  return names;
}

/** What the gate's dashboard_files row reads: index.html, at least one .css and one .js, nothing else odd. */
function dashboardIssue(files: string[]): string | null {
  if (!files.includes('index.html')) return 'dashboard/ holds no index.html';
  if (!files.some((name) => name.endsWith('.css'))) return 'dashboard/ holds no .css file';
  if (!files.some((name) => name.endsWith('.js'))) return 'dashboard/ holds no .js file';
  return null;
}

function main(): number {
  if (process.argv.includes('--help')) {
    process.stdout.write(usage());
    return 0;
  }
  if (process.argv.includes('--version')) {
    process.stdout.write(`token-radar ${ENTRY_VERSION}\n`);
    return 0;
  }

  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    return refuse(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
  }
  const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  let snapshot;
  try {
    snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) return refuse(`the model wrote a board the gate refuses: ${issue}`);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));

  copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  const pageFiles = existsSync(join(out, 'dashboard')) ? readdirSync(join(out, 'dashboard')) : [];
  const pageIssue = dashboardIssue(pageFiles);
  if (pageIssue !== null) return refuse(`${pageIssue} (copy dashboard/ from this repository)`);

  const shots = decodeShots(join(here, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < SCREENSHOT_CAPS.min || shots.length > SCREENSHOT_CAPS.max) {
    return refuse(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in ${SCREENSHOT_CAPS.min}, the board, a detail view and a filtered view`);
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: SCREENSHOT_CAPS.max, max_bytes: SCREENSHOT_CAPS.max_bytes }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

  const pageBytes = pageFiles.reduce((sum, name) => sum + statSync(join(out, 'dashboard', name)).size, 0);
  process.stdout.write(
    `token radar ${ENTRY_VERSION}: snapshot as of ${snapshot.as_of}, ${snapshot.source}\n` +
      `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${pageFiles.length} files, ${pageBytes} bytes), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
  return 0;
}

process.exitCode = main();