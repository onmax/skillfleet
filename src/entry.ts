#!/usr/bin/env node
// The bin. It checks the Node version before the bundle loads, since an older Node fails to parse
// the bundle with a SyntaxError that names no version. Keep this file to syntax old versions read:
// no top-level await. MAJOR.MINOR matches `engines` in package.json.
import module from "node:module";
import { basename, dirname, join } from "node:path";

const [MAJOR, MINOR] = [22, 12];
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MAJOR || (major === MAJOR && minor < MINOR)) {
  console.error(
    `fleetrc needs Node.js ${MAJOR}.${MINOR} or newer, and this is Node.js ${process.versions.node} (${process.execPath}).`,
  );
  process.exit(1);
}
// The installed copy, `<state>/app/cli.mjs`, which hooks, the timer and the launcher run, keeps its
// compiled bundle in `<state>/app/compile`, so a run after the first skips most of its parse. Any
// other copy (npx, a checkout), a dry run and a session hook write nothing for it.
const args = process.argv.slice(2);
const script = process.argv[1] ?? "";
if (
  basename(script) === "cli.mjs" &&
  basename(dirname(script)) === "app" &&
  !args.includes("--dry-run") &&
  // A hook loads little, and runs on machines fleetrc may not have set up.
  args[0] !== "hook"
)
  try {
    // Node 22.1 and newer; a folder that can't be made leaves the cache off.
    module.enableCompileCache?.(join(dirname(script), "compile"));
  } catch {}
// What an agent's session hook runs, when a session starts: hook.ts alone, without the rest of the
// CLI. `hook prompt`, the legacy Claude Code hook, only reports new skills and never starts a sync.
const [command, action, agent] = args;
if (command === "hook" && action === "prompt" && process.argv.length === 4)
  void import("./hook.ts").then((hook) => hook.runHook("claude-code", true));
else if (
  command === "hook" &&
  action === "run" &&
  (agent === "claude-code" || agent === "codex") &&
  process.argv.length === 5
)
  void import("./hook.ts").then((hook) => hook.runHook(agent));
// What programs built on fleetrc run: list.ts reads state.json alone. An error it meets (a
// state.json it may not read) goes to the CLI, which says it in one line.
else if (command === "list" && action === "--json" && process.argv.length === 4)
  void import("./list.ts").then((list) => list.printSkillList()).catch(() => import("./cli.ts"));
else if ((command === "--version" || command === "-v") && process.argv.length === 3)
  void import("./version.ts").then(({ version }) => console.log(version));
else void import("./cli.ts");
