/**
 * LlmProvider adapters backed by a local coding-CLI subscription (dev/demo only).
 *
 * These shell out to `claude` or `codex` — the builder's existing subscription does the inference, so
 * onboarding costs nothing extra to try. They are NOT for production: a hosted Tap that wants to
 * self-heal uses an API-key provider (openai / openrouter) instead. The prompt goes in on stdin to
 * dodge argv length limits; the response text is returned verbatim for the pipeline to JSON-extract.
 *
 * CLAUDE.md invariant 1 still holds: this runs at ONBOARDING time, never in the request hot path.
 */
import { spawn } from "node:child_process";
import type { LlmProvider } from "../../core/onboard";
import { type Result, err, ok } from "../../core/result";

type SpawnResult = { code: number; stdout: string; stderr: string };

/** Run a binary, feed `input` on stdin, collect stdout/stderr. Rejects only on spawn failure. */
function run(bin: string, args: string[], input: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject); // e.g. ENOENT — binary not installed
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Claude Code CLI. Uses `-p` (print/non-interactive) with JSON output; the system prompt is appended
 * via `--append-system-prompt` and the user input is piped on stdin. Returns the `.result` field.
 */
export function claudeCli(opts: { bin?: string } = {}): LlmProvider {
  const bin = opts.bin ?? "claude";
  return {
    async complete({ system, input }): Promise<Result<string, { message: string }>> {
      try {
        const res = await run(
          bin,
          // Clear hooks for this call so a programmatic prompt runs cleanly and never inherits the
          // operator's interactive session state (e.g. a "caveman" persona hook). Auth is untouched.
          [
            "-p",
            "--settings",
            '{"hooks":{}}',
            "--output-format",
            "json",
            "--append-system-prompt",
            system,
          ],
          input,
        );
        if (res.code !== 0)
          return err({ message: `${bin} exited ${res.code}: ${res.stderr.trim()}` });
        // --output-format json → { result: "...", ... }; fall back to raw stdout if shape differs.
        try {
          const parsed = JSON.parse(res.stdout) as { result?: unknown };
          if (typeof parsed.result === "string") return ok(parsed.result);
        } catch {
          /* not JSON — use raw */
        }
        return ok(res.stdout);
      } catch (e) {
        return err({ message: spawnErr(bin, e) });
      }
    },
  };
}

/**
 * Codex CLI. Uses `exec` (non-interactive); system + input are concatenated and piped on stdin.
 * Returns stdout (the final assistant message). `--` ensures stdin is used as the prompt.
 */
export function codexCli(opts: { bin?: string } = {}): LlmProvider {
  const bin = opts.bin ?? "codex";
  return {
    async complete({ system, input }): Promise<Result<string, { message: string }>> {
      const prompt = `${system}\n\n${input}`;
      try {
        const res = await run(bin, ["exec", "--"], prompt);
        if (res.code !== 0)
          return err({ message: `${bin} exited ${res.code}: ${res.stderr.trim()}` });
        return ok(res.stdout);
      } catch (e) {
        return err({ message: spawnErr(bin, e) });
      }
    },
  };
}

/** Select a dev provider by name (used by the CLI's `--llm` flag). */
export function devLlm(name: "claude" | "codex"): LlmProvider {
  return name === "codex" ? codexCli() : claudeCli();
}

function spawnErr(bin: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("ENOENT")) return `'${bin}' not found on PATH — install it or pass --llm`;
  return msg;
}
