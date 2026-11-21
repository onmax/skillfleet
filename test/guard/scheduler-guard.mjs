// Keeps tests away from the OS scheduler. test/fixture.ts loads this into every Node process a test
// starts (NODE_OPTIONS=--import), and vite.config.ts into vitest's workers. Any spawn of a
// scheduler command (systemctl, loginctl, launchctl, schtasks, or PowerShell running a
// ScheduledTask cmdlet) runs fake-scheduler.mjs instead, whatever PATH holds and even by absolute
// path. The one exception is a fake that a test put inside its own machine folder
// ($FLEETRC_TEST_ROOT) and on PATH, as the linger tests do with loginctl.
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fake = fileURLToPath(new URL("./fake-scheduler.mjs", import.meta.url));
const SCHEDULER = new Set(["systemctl", "loginctl", "launchctl", "schtasks", "journalctl"]);
const GUARDED = Symbol.for("fleetrc.test.scheduler-guard");

/** The script of a PowerShell call, decoded from -EncodedCommand. */
const powershellScript = (args) =>
  args
    .map((arg, i) =>
      /^-e(nc(odedcommand)?)?$/i.test(String(args[i - 1] ?? ""))
        ? Buffer.from(String(arg), "base64").toString("utf16le")
        : String(arg),
    )
    .join(" ");

function isScheduler(file, args) {
  const name = basename(String(file))
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat)$/, "");
  if (SCHEDULER.has(name)) return true;
  if (name === "powershell" || name === "pwsh")
    return /ScheduledTask|Schedule\.Service|schtasks/i.test(powershellScript(args));
  return false;
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** A fake the test made in its own folder, found where the spawn would find it (POSIX only). */
function testsOwn(file, env) {
  const root = env.FLEETRC_TEST_ROOT;
  if (!root || process.platform === "win32") return false;
  const name = String(file);
  if (name.includes("/")) return inside(root, name);
  const found = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path));
  return found !== undefined && inside(root, found);
}

function reroute(original) {
  if (original[GUARDED]) return original;
  const wrapped = function (file, ...rest) {
    const args = Array.isArray(rest[0]) ? rest.shift() : [];
    const options = rest[0] && typeof rest[0] === "object" ? rest[0] : undefined;
    if (options?.shell || !isScheduler(file, args) || testsOwn(file, options?.env ?? process.env))
      return original.call(this, file, args, ...rest);
    return original.call(this, process.execPath, [fake, String(file), ...args], ...rest);
  };
  wrapped[GUARDED] = true;
  return wrapped;
}

childProcess.spawn = reroute(childProcess.spawn);
childProcess.spawnSync = reroute(childProcess.spawnSync);
childProcess.execFileSync = reroute(childProcess.execFileSync);
if (!childProcess.execFile[GUARDED]) {
  const execFile = reroute(childProcess.execFile);
  // util.promisify(execFile) would otherwise use Node's own, unguarded version.
  execFile[promisify.custom] = (...args) =>
    new Promise((resolve, reject) => {
      execFile(...args, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
  childProcess.execFile = execFile;
}
syncBuiltinESMExports();
