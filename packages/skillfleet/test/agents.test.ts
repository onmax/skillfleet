// Breaks found by running real agents (Claude Code, Codex, Gemini CLI, OpenCode, Copilot CLI, Grok,
// Goose, Amp) against the folders skillfleet links. Each case states what a user should get; they
// fail until the matching fix lands.
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { machine, remote, skills } from "./fixture.ts";

const names = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : [];

describe("agents", () => {
  // Gemini CLI 0.68 reads both ~/.gemini/skills and ~/.agents/skills. When a name is in both, it
  // shows "Skill conflict detected: ... is overriding the same skill" once per skill on every start.
  // `npx skills add -g` installs Gemini's skills only into ~/.agents/skills for this reason.
  it("A1. Gemini CLI sees each skill once when Codex is also linked", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const manifest = m.manifest({
      agents: ["codex", "gemini-cli"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-timer");
    expect(init.code, init.stderr).toBe(0);
    const canonical = names(m.at(".agents/skills"));
    expect(canonical).toEqual(["alpha", "beta"]);
    const both = names(m.at(".gemini/skills")).filter((name) => canonical.includes(name));
    expect(both).toEqual([]);
  });

  // `skills` reads these to find an agent's folder. The timer runs without the shell's profile, so
  // without them it links ~/.grok/skills while Grok reads $GROK_HOME/skills.
  it.each([
    "GROK_HOME",
    "VIBE_HOME",
    "HERMES_HOME",
    "AUTOHAND_HOME",
    "SARVAM_HOME",
    "REASONIX_HOME",
  ])("A2. the timer keeps %s, which places an agent's skills folder", async (key) => {
    const { timerEnv } = await import("../src/timer.ts");
    const saved = process.env[key];
    process.env[key] = "/somewhere/else";
    try {
      expect(timerEnv(undefined)[key]).toBe("/somewhere/else");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
