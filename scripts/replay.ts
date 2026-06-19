/**
 * Demo movie player — replays a captured run as narratable beats for recording a video.
 *
 * The numbers in the movie file are from real measured runs (scripts/demo.ts + refresh-doaj.ts); this
 * just renders them at a pace you control, so the on-screen action lines up with your narration.
 *
 *   npx tsx scripts/replay.ts                  manual — press SPACE/→ to advance each beat (default)
 *   npx tsx scripts/replay.ts --auto           auto — each beat holds for its scripted time (~2:45)
 *   npx tsx scripts/replay.ts --auto --speed 1.3   auto, 1.3× faster
 *   npx tsx scripts/replay.ts --clean         hide the 🎤 cues — RECORD THIS (read the script off-screen)
 *   npx tsx scripts/replay.ts recordings/demo-movie.json   explicit movie file
 *
 * Manual keys:  SPACE / ENTER / →  next   ·   b / ←  redo last beat   ·   q / Ctrl-C  quit
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Line = { text: string; style?: string; type?: boolean };
type Scene = { act?: string; rule?: string; narration?: string; render?: Line[]; hold?: number };
type Movie = { meta?: { title?: string }; scenes: Scene[] };

const C: Record<string, (s: string) => string> = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  plain: (s) => s,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  cmd: (s) => `\x1b[1m\x1b[37m${s}\x1b[0m`,
};
const style = (s: string, name = "plain") => (C[name] ?? C.plain)(s);

const args = process.argv.slice(2);
const auto = args.includes("--auto");
const clean = args.includes("--clean"); // hide the 🎤 narration cues — for the on-screen recording
const speed = Number(args[args.indexOf("--speed") + 1]) || 1;
const file = args.find((a) => a.endsWith(".json")) ?? "recordings/demo-movie.json";
const typeCps = 90 * (auto ? speed : 1); // chars/sec for the typing reveal

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (s: string) => process.stdout.write(s);

const KEY_QUIT = new Set(["", "q"]); // Ctrl-C, q
const KEY_BACK = new Set(["b", "[D"]); // b, ←

async function typeLine(text: string, name?: string): Promise<void> {
  // Reveal char-by-char, then repaint the whole line styled — keeps ANSI clean. The \r overwrite only
  // works on a real terminal; when piped, just print the final line so the output stays readable.
  if (!process.stdout.isTTY) {
    out(`${style(text, name)}\n`);
    return;
  }
  for (let i = 1; i <= text.length; i++) {
    out(`\r${text.slice(0, i)}`);
    await sleep(1000 / typeCps);
  }
  out(`\r${style(text, name)}\n`);
}

function header(scene: Scene): void {
  if (scene.act) out(`\n${style("━".repeat(72), "dim")}\n${style(`  ACT ${scene.act}`, "dim")}\n`);
  if (scene.rule) out(`\n${C.bold(C.cyan(scene.rule))}\n${style("─".repeat(72), "dim")}\n`);
}

function narrate(text?: string): void {
  if (!text || clean) return;
  const width = 74;
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (`${cur} ${w}`.trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur += ` ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  out(`\n${style("  🎤 say ┃ ", "dim")}${style(lines[0] ?? "", "dim")}\n`);
  for (const l of lines.slice(1)) out(`${style("        ┃ ", "dim")}${style(l, "dim")}\n`);
}

async function renderScene(scene: Scene): Promise<void> {
  header(scene);
  for (const ln of scene.render ?? []) {
    if (ln.type) await typeLine(ln.text, ln.style);
    else out(`${style(ln.text, ln.style)}\n`);
  }
  narrate(scene.narration);
}

// ── manual keypress control ────────────────────────────────────────────────
let resolveKey: ((k: string) => void) | null = null;
function setupKeys(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k: string) => {
    if (KEY_QUIT.has(k)) {
      out("\n");
      process.exit(0);
    }
    resolveKey?.(k);
    resolveKey = null;
  });
}
function nextKey(): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(" ");
  return new Promise((res) => {
    resolveKey = res;
  });
}

async function main(): Promise<void> {
  const movie = JSON.parse(readFileSync(resolve(file), "utf8")) as Movie;
  out("\x1b[2J\x1b[H"); // clear
  out(C.bold(`\n  ${movie.meta?.title ?? "demo"}\n`));
  out(
    style(
      `  ${auto ? `auto · ${speed}×` : "manual · SPACE = next · b = back · q = quit"} · ${movie.scenes.length} beats\n`,
      "dim",
    ),
  );
  setupKeys();
  if (!auto) await nextKey();

  for (let i = 0; i < movie.scenes.length; i++) {
    await renderScene(movie.scenes[i]);
    if (auto) {
      await sleep(((movie.scenes[i].hold ?? 6) * 1000) / speed);
    } else {
      const k = await nextKey();
      if (KEY_BACK.has(k) && i > 0) i -= 2; // redo previous beat
    }
  }
  out(style("\n  — end —\n\n", "dim"));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
