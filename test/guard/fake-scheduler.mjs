// Stands in for every command that reaches the OS scheduler (systemd, launchd, Task Scheduler) in
// tests: scheduler-guard.mjs and the shims test/fixture.ts puts first on PATH send those commands
// here. It records each call in $FLEETRC_TEST_SCHEDULER_LOG and, by $FLEETRC_TEST_SCHEDULER:
//   forbid (default)  refuses every call; the fixture fails the test after it ends.
//   refuse            refuses every call, for tests that check how fleetrc reports the failure.
//   empty             answers reads like a machine with no timer and linger off; refuses changes,
//                     and the fixture fails the test for those.
//   absent            answers systemctl, loginctl and journalctl as a Linux machine without
//                     systemd does: they are not installed (exit 127, spawn ENOENT).
// A refused call exits 97 with a message that names the call.
import { appendFileSync } from "node:fs";

const [command = "", ...args] = process.argv.slice(2);
const mode = process.env.FLEETRC_TEST_SCHEDULER || "forbid";
const name = command
  .replace(/^.*[\\/]/, "")
  .toLowerCase()
  .replace(/\.(exe|com|cmd|bat)$/, "");

/** The script a PowerShell call runs, decoded from -EncodedCommand. */
function script() {
  return args
    .map((arg, i) =>
      /^-e(nc(odedcommand)?)?$/i.test(args[i - 1] ?? "")
        ? Buffer.from(arg, "base64").toString("utf16le")
        : arg,
    )
    .join(" ");
}

/** What a machine with no fleetrc timer answers to a read, or undefined for a change. */
function emptyAnswer() {
  const verb = args.find((arg) => !arg.startsWith("-"));
  switch (name) {
    case "systemctl": {
      if (verb === "show") {
        const units = args.filter((arg) => /\.(timer|service)$/.test(arg));
        // `show -p UnitPath --value` with nothing to say: fleetrc keeps its own XDG_CONFIG_HOME.
        const stdout = units
          .map((unit) => `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n`)
          .join("\n");
        return { code: 0, stdout: stdout || "\n" };
      }
      if (verb === "is-active") return { code: 3, stdout: "inactive\n" };
      return undefined;
    }
    case "loginctl":
      if (verb === "show-user")
        return { code: 0, stdout: args.includes("--value") ? "no\n" : "Linger=no\n" };
      return undefined;
    case "launchctl":
      if (verb === "print")
        return {
          code: 113,
          stderr: `Could not find service "${args.at(-1)}" in domain for port\n`,
        };
      if (verb === "getenv") return { code: 0, stdout: "" };
      return undefined;
    case "powershell":
    case "pwsh": {
      const text = script();
      if (
        /Get-ScheduledTask/.test(text) &&
        !/(Register|Start|Stop|Set|Enable)-Scheduled/.test(text)
      )
        return { code: 0, stdout: '{"installed":false}\n' };
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A Linux machine without systemd, such as a container: its commands are not installed. */
function absentAnswer() {
  if (!["systemctl", "loginctl", "journalctl"].includes(name)) return undefined;
  return { code: 127, stderr: `spawn ${name} ENOENT\n` };
}

const answer = mode === "empty" ? emptyAnswer() : mode === "absent" ? absentAnswer() : undefined;
const shown =
  name === "powershell" || name === "pwsh" ? `${name} ${script()}` : [name, ...args].join(" ");
if (process.env.FLEETRC_TEST_SCHEDULER_LOG)
  appendFileSync(
    process.env.FLEETRC_TEST_SCHEDULER_LOG,
    `${JSON.stringify({ command: shown, answered: answer !== undefined })}\n`,
  );
if (answer) {
  process.stdout.write(answer.stdout ?? "");
  process.stderr.write(answer.stderr ?? "");
  process.exit(answer.code);
}
process.stderr.write(
  `fleetrc tests: refused \`${shown}\`: tests never reach this machine's real scheduler. ` +
    `Pass machine({ scheduler: "empty" }) for a scheduler with no timer, or ` +
    `machine({ scheduler: "refuse" }) to test this failure.\n`,
);
process.exit(97);
