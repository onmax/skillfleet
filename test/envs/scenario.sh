#!/bin/sh
# The user scenario, run inside a container (or a throwaway HOME) against the packed tarball.
#
#   SF_TGZ=/pkg/fleetrc.tgz sh scenario.sh
#
# Environment:
#   SF_TGZ      the packed tarball (required)
#   SF_HOME     the HOME to use; created when missing (default: $HOME). Spaces and Unicode are fine.
#   SF_SRV      where the bare git repositories go (default: $SF_HOME/.scenario/srv)
#   SF_RUNNER   how init is run: npx (default), pnpm-dlx or global
#   SF_SKIP     space-separated step names to skip
#   SF_TIMER    1 to let init install a real timer (--timer) on a machine with systemd; by
#               default only a machine without systemd gets --timer, where init explains why it
#               can't install one, so the scenario never leaves a timer on a host
#
# Every step prints `PASS <step>` or `FAIL <step>: <why>`, and the script ends with a summary line
# `SUMMARY pass=<n> fail=<n>`. It never stops at the first failure, so one run shows every break.
set -u

: "${SF_TGZ:?set SF_TGZ to the packed tarball}"
SF_HOME="${SF_HOME:-$HOME}"
mkdir -p "$SF_HOME"
SF_HOME="$(cd "$SF_HOME" && pwd)"
WORK="${SF_WORK:-$SF_HOME/.scenario}"
SF_SRV="${SF_SRV:-$WORK/srv}"
SF_RUNNER="${SF_RUNNER:-npx}"
SF_SKIP="${SF_SKIP:-}"

export HOME="$SF_HOME"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME XDG_DATA_HOME CLAUDE_CONFIG_DIR CODEX_HOME
export DO_NOT_TRACK=1 NO_COLOR=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export GIT_CONFIG_GLOBAL="$SF_HOME/.gitconfig" GIT_CONFIG_NOSYSTEM=1
STATE="$HOME/.local/state/fleetrc"
SF="$STATE/bin/fleetrc"
LOG="${SF_LOG:-$WORK/logs}"
mkdir -p "$LOG" "$SF_SRV"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1: $2"; }
skip() { case " $SF_SKIP " in *" $1 "*) echo "SKIP $1"; return 0 ;; esac; return 1; }
# run <step> <cmd...>: runs a command, keeps its output in $LOG/<step>.out and its code in $code.
run() {
  step="$1"
  shift
  "$@" >"$LOG/$step.out" 2>&1
  code=$?
  return 0
}
show() { sed 's/^/    | /' "$LOG/$1.out" | tail -n "${2:-15}"; }
has() { grep -q -- "$2" "$LOG/$1.out"; }

if command -v git >/dev/null 2>&1; then HAVE_GIT=1; else HAVE_GIT=0; fi

cat >"$GIT_CONFIG_GLOBAL" <<'EOF'
[user]
	name = scenario
	email = scenario@example.com
[init]
	defaultBranch = main
[commit]
	gpgsign = false
[protocol "file"]
	allow = always
[advice]
	detachedHead = false
EOF

echo "ENV node=$(node -v) git=$(git --version 2>/dev/null || echo none) home=$HOME runner=$SF_RUNNER uid=$(id -u)"

# Agents fleetrc should detect: Claude Code, Codex and Gemini CLI.
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini"

# --- the remotes ---------------------------------------------------------------------------------
skill_md() { printf -- '---\nname: %s\ndescription: The %s skill\n---\n%s\n' "$1" "$1" "${2:-$1 body}"; }

# bare <name>: a bare repository at $SF_SRV/<name>.git with a work clone at $SF_SRV/work/<name>.
bare() {
  git init --quiet --bare "$SF_SRV/$1.git"
  git init --quiet "$SF_SRV/work/$1"
  git -C "$SF_SRV/work/$1" remote add origin "$SF_SRV/$1.git"
}
push() { (cd "$SF_SRV/work/$1" && git add -A && git commit --quiet -m "${2:-change}" && git push --quiet origin main 2>/dev/null); }

if [ "$HAVE_GIT" = 1 ]; then
  rm -rf "$SF_SRV"
  mkdir -p "$SF_SRV/work"
  bare team
  mkdir -p "$SF_SRV/work/team/skills/team-a"
  skill_md team-a >"$SF_SRV/work/team/skills/team-a/SKILL.md"
  push team init
  bare mine
  mkdir -p "$SF_SRV/work/mine/skills/mine-a"
  skill_md mine-a >"$SF_SRV/work/mine/skills/mine-a/SKILL.md"
  push mine init
  bare extra
  mkdir -p "$SF_SRV/work/extra/skills/extra-a"
  skill_md extra-a >"$SF_SRV/work/extra/skills/extra-a/SKILL.md"
  push extra init
  bare manifest
  mkdir -p "$SF_SRV/work/manifest/.fleetrc"
  cat >"$SF_SRV/work/manifest/.fleetrc/manifest.json" <<EOF
{
  "agents": "all",
  "sources": [
    { "id": "mine", "git": "$SF_SRV/mine.git", "path": "~/src/my skills", "skills": "skills/*", "adopt": true },
    { "id": "team", "git": "$SF_SRV/team.git", "skills": "skills/*" }
  ]
}
EOF
  push manifest init
fi
MANIFEST="$SF_SRV/manifest.git"
if [ "$HAVE_GIT" = 0 ]; then
  # No git: a plain manifest file with a local source, and a git source that must fail clearly.
  rm -rf "$SF_SRV"
  mkdir -p "$SF_SRV/local-skills/loc-a" "$SF_SRV/manifest/.fleetrc"
  skill_md loc-a >"$SF_SRV/local-skills/loc-a/SKILL.md"
  cat >"$SF_SRV/manifest/.fleetrc/manifest.json" <<JSON
{
  "agents": "all",
  "sources": [
    { "id": "loc", "local": "$SF_SRV/local-skills" },
    { "id": "team", "git": "https://example.invalid/team.git" }
  ]
}
JSON
  MANIFEST="$SF_SRV/manifest"
fi
# A skill the user made by hand before fleetrc: init adopts it into the clone it makes first.
if [ "$HAVE_GIT" = 1 ]; then
  mkdir -p "$HOME/.claude/skills/handmade"
  skill_md handmade >"$HOME/.claude/skills/handmade/SKILL.md"
fi
# A folder the user made read-only, e.g. SF_RO=.gemini/skills.
if [ -n "${SF_RO:-}" ]; then mkdir -p "$HOME/$SF_RO" && chmod 555 "$HOME/$SF_RO"; fi

# --- install and init ----------------------------------------------------------------------------
init_cmd() {
  case "$SF_RUNNER" in
    npx) npx -y --package "$SF_TGZ" -- fleetrc "$@" ;;
    pnpm-dlx) pnpm dlx --package "$SF_TGZ" fleetrc "$@" ;;
    global) fleetrc "$@" ;;
  esac
}
if [ "$SF_RUNNER" = global ]; then
  run install npm install -g "$SF_TGZ"
  [ "$code" = 0 ] && ok install || { bad install "npm install -g exited $code"; show install; }
fi

run version init_cmd --version
[ "$code" = 0 ] && ok "version $(head -n1 "$LOG/version.out")" || { bad version "exit $code"; show version; }

# A machine booted with systemd would get a real timer from init --timer; the scenario leaves hosts alone.
SYSTEMD=0
[ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && SYSTEMD=1
TIMER_FLAG=""
{ [ "$SYSTEMD" = 0 ] || [ "${SF_TIMER:-}" = 1 ]; } && TIMER_FLAG=--timer
if ! skip init; then
  # shellcheck disable=SC2086
  run init init_cmd init "$MANIFEST" $TIMER_FLAG
  # Without git, the git source fails, so init reports a sync with errors.
  if [ "$HAVE_GIT" = 1 ]; then want=0; else want=1; fi
  if [ "$code" = "$want" ]; then ok "init exit $code"; else bad init "exit $code, expected $want"; fi
  show init 40
  if [ "$SYSTEMD" = 0 ]; then
    # No systemd user manager (a container): init says so and what to use instead.
    if has init "no systemd user manager" && has init "crontab" && ! has init ENOENT; then ok init-no-systemd; else
      bad init-no-systemd "init does not explain the missing systemd: $(grep -i 'timer' "$LOG/init.out" | head -n2 | tr '\n' ' ')"
    fi
  fi
fi

# Every agent folder fleetrc should have written. Gemini CLI reads ~/.agents/skills, which Codex
# also reads, so its own folder gets no links: Gemini warns about a skill it finds in both.
check_linked() { # check_linked <step> <skill>...
  s="$1"
  shift
  missing=""
  twice=""
  for skill in "$@"; do
    for dir in .claude/skills .agents/skills; do
      [ -f "$HOME/$dir/$skill/SKILL.md" ] || missing="$missing $dir/$skill"
    done
    [ -e "$HOME/.gemini/skills/$skill" ] && twice="$twice .gemini/skills/$skill"
  done
  if [ -n "$missing" ]; then bad "$s" "not linked:$missing"
  elif [ -n "$twice" ]; then bad "$s" "linked into Gemini's own folder too:$twice"
  else ok "$s"; fi
}
if [ "$HAVE_GIT" = 1 ]; then
  check_linked init-links team-a mine-a handmade
  # handmade moved into the clone init made, and every agent sees it from there.
  if [ -f "$HOME/src/my skills/.git/HEAD" ] && [ -f "$HOME/src/my skills/skills/handmade/SKILL.md" ] && [ -L "$HOME/.claude/skills/handmade" ]; then
    ok init-adopt
  else
    bad init-adopt "handmade is not in the clone, linked: $(ls -la "$HOME/.claude/skills" 2>&1 | grep handmade)"
  fi
else
  check_linked init-links-local loc-a
  if grep -Eqi 'git (is not|isn.t) (installed|on PATH)|install git|needs git' "$LOG/init.out"; then ok no-git-message; else
    bad no-git-message "the git source fails without saying git is missing: $(grep -i 'team' "$LOG/init.out" | grep -iv 'link' | head -n2 | tr '\n' ' ')"
  fi
fi

# The launcher init writes, and that it runs on its own.
if [ -x "$SF" ]; then ok launcher; else bad launcher "$SF missing after init"; fi
if command -v fleetrc >/dev/null 2>&1 && [ "$SF_RUNNER" != global ]; then
  echo "NOTE fleetrc is on PATH after init: $(command -v fleetrc)"
elif [ "$SF_RUNNER" != global ]; then
  echo "NOTE fleetrc is not on PATH after init; the README's \`fleetrc status\` needs $SF"
fi

# The npx cache can go; the copy keeps working.
rm -rf "$HOME/.npm/_npx" "$HOME/.cache/pnpm/dlx" "$HOME/.local/share/pnpm" 2>/dev/null
run launcher-after-cache "$SF" --version
[ "$code" = 0 ] && ok launcher-after-cache || { bad launcher-after-cache "exit $code"; show launcher-after-cache; }
sf() { "$SF" "$@"; }

# --- upstream adds a skill -----------------------------------------------------------------------
if [ "$HAVE_GIT" = 1 ]; then
  mkdir -p "$SF_SRV/work/team/skills/team-b"
  skill_md team-b >"$SF_SRV/work/team/skills/team-b/SKILL.md"
  push team "add team-b"
  run sync-upstream sf sync
  [ "$code" = 0 ] || { bad sync-upstream "exit $code"; show sync-upstream; }
  check_linked sync-upstream-links team-b

  # `add` refuses to edit a copy of a remote manifest, which the next sync fetches again, and says
  # where to make the change; made there and pushed, the source arrives with the next sync.
  run add sf add "$SF_SRV/extra.git" --skills 'skills/*'
  if [ "$code" = 1 ] && has add "push it"; then ok add-remote-refused; else
    bad add-remote-refused "exit $code"
    show add
  fi
  cat >"$SF_SRV/work/manifest/.fleetrc/manifest.json" <<EOF
{
  "agents": "all",
  "sources": [
    { "id": "mine", "git": "$SF_SRV/mine.git", "path": "~/src/my skills", "skills": "skills/*", "adopt": true },
    { "id": "team", "git": "$SF_SRV/team.git", "skills": "skills/*" },
    { "id": "extra", "git": "$SF_SRV/extra.git", "skills": "skills/*" }
  ]
}
EOF
  push manifest "add extra"
  run add-sync sf sync
  [ "$code" = 0 ] || { bad add-sync "exit $code"; show add-sync; }
  check_linked add-links extra-a
  run add-survives sf sync
  if [ -f "$HOME/.claude/skills/extra-a/SKILL.md" ]; then ok add-survives-sync; else
    bad add-survives-sync "extra-a was unlinked by the next sync"
    show add-survives
  fi

  # --- edit a linked skill, while upstream changes it too ----------------------------------------
  printf '\nmy local note\n' >>"$HOME/.claude/skills/team-a/SKILL.md"
  skill_md team-a "team-a body v2" >"$SF_SRV/work/team/skills/team-a/SKILL.md"
  push team "team-a v2"
  run sync-edit sf sync --json
  if grep -q "my local note" "$HOME/.claude/skills/team-a/SKILL.md"; then ok edit-kept; else
    bad edit-kept "the local edit to team-a was overwritten"
  fi
  if has sync-edit '"edited"' && grep -q team-a "$LOG/sync-edit.out"; then ok edit-reported; else
    bad edit-reported "the sync report does not mention the edited team-a"
  fi
  run status-edit sf status
  if has status-edit team-a; then ok status-mentions-edit; else
    bad status-mentions-edit "status does not mention team-a"
    show status-edit 20
  fi
  run diff-edit sf diff team-a
  [ "$code" = 0 ] && has diff-edit "my local note" && ok diff || { bad diff "exit $code"; show diff-edit; }

  # Edit the in-place clone, the way an agent edits ~/src/my skills.
  printf '\nclone edit\n' >>"$HOME/src/my skills/skills/mine-a/SKILL.md"
  run sync-clone-edit sf sync
  [ "$code" = 0 ] && grep -q "clone edit" "$HOME/.claude/skills/mine-a/SKILL.md" && ok clone-edit ||
    { bad clone-edit "exit $code"; show sync-clone-edit; }
fi

# --- read-only commands --------------------------------------------------------------------------
run status sf status
[ "$code" = 0 ] && ok status || bad status "exit $code"
show status 25
run list sf list
[ "$code" = 0 ] && ok list || bad list "exit $code"
show list
run doctor sf doctor
echo "INFO doctor exit $code"
show doctor 20
if grep -Eq '^(ok  |FAIL|skip) timer' "$LOG/doctor.out"; then ok doctor-checks-timer; else bad doctor-checks-timer "doctor prints no timer check (exit $code)"; fi
run timer-status sf timer status
echo "INFO timer status exit $code: $(head -n1 "$LOG/timer-status.out")"
run timer-dry sf timer install --dry-run
echo "INFO timer install --dry-run exit $code"
show timer-dry 6
if [ "$SYSTEMD" = 0 ]; then
  # Every timer command names the missing systemd, never spawn ENOENT, and the dry run promises nothing.
  for step in status doctor timer-status timer-dry; do
    if has "$step" "no systemd user manager" && ! has "$step" ENOENT; then ok "$step-no-systemd"; else
      bad "$step-no-systemd" "$(grep -i -m1 'timer' "$LOG/$step.out")"
    fi
  done
  if has timer-dry "would install"; then bad timer-dry-honest "the dry run says it would install a timer"; else ok timer-dry-honest; fi
fi

# --- offline -------------------------------------------------------------------------------------
if [ "$HAVE_GIT" = 1 ]; then
  run offline sf sync --offline
  [ "$code" = 0 ] && ok offline-sync || { bad offline-sync "exit $code"; show offline; }
fi

# --- uninstall -----------------------------------------------------------------------------------
run timer-remove sf timer remove
echo "INFO timer remove exit $code: $(head -n1 "$LOG/timer-remove.out")"
for cmd in uninstall unlink; do
  run "$cmd" sf "$cmd"
  if has "$cmd" "unknown command"; then echo "INFO no \`$cmd\` command"; fi
done

echo "SUMMARY pass=$pass fail=$fail"
