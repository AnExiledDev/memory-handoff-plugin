"""Drive real Claude Code sessions through the memory-handoff plugin's integration.

Every check here runs a throwaway pty session against an isolated
`CLAUDE_CONFIG_DIR`, an isolated `MEMORY_HANDOFF_DIR` and an isolated
`COMPACT_HANDOFF_DATA_DIR`, in a throwaway git repository of its own, so nothing
it does touches the operator's config, this box's hooks, the memories of any
session a person is actually using, or the project key of any real repo. What it
asserts is read back out of the rows the plugin wrote to `memory.sqlite`, never
out of what the terminal printed: a pane on screen is not evidence that anything
was stored or retrieved.

    python3 bench/verify-injection.py setup
    python3 bench/verify-injection.py run compact inject
    python3 bench/verify-injection.py table

Needs `pexpect` (`pip install pexpect`), a `claude` on PATH with the
function-hooks runtime, and credentials in the real `~/.claude` that `setup`
copies into the scratch config. Every session it spawns is a paid model call.

`setup` writes the isolated config and builds the scratch project (a fresh `git
init` with one commit, which is what makes the project key its own). `run` takes
check names, or `all`. Each check appends its own verdict to `verify.jsonl` in
the scratch dir, so a check that fails can be re-run on its own without paying
for the ones that passed.

Two plugins are under test together. compact-handoff answers `session.compact`
without calling `next`, so memory-handoff reaches the transcript through its
seam; the checks that care about that load both plugins, compact-handoff first,
and read `via` back off the row. The rest load memory-handoff alone.

The session model is deliberately settable: these checks verify the *mechanism*,
and the mechanism does not care which model wrote the memories.
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

import pexpect

# Both plugin roots, overridable so this file can outlive the clone it was
# written against. memory-handoff is the thing under test; compact-handoff is
# the other half of the seam.
HERE = os.path.dirname(os.path.abspath(__file__))
# The plugin under test is the checkout this file sits in; compact-handoff is
# the sibling checkout unless pointed elsewhere. The scratch tree lives under
# bench/.verify (gitignored), so a run never touches the real ~/.claude.
PLUGIN = os.environ.get("MEMORY_HANDOFF_PLUGIN") or os.path.dirname(HERE)
COMPACT_HANDOFF = os.environ.get("COMPACT_HANDOFF_PLUGIN") or os.path.join(os.path.dirname(PLUGIN), "compact-handoff")
SCRATCH = os.environ.get("MEMORY_HANDOFF_VERIFY_DIR") or os.path.join(HERE, ".verify")
CONFIG = os.path.join(SCRATCH, "config")
DATA = os.path.join(SCRATCH, "data")
CH_DATA = os.path.join(SCRATCH, "ch-data")
LOGS = os.path.join(SCRATCH, "logs")
PROJECT = os.path.join(SCRATCH, "project")
VERDICTS = os.path.join(SCRATCH, "verify.jsonl")

# `schema/bun-sqlite.js` puts the database at `<MEMORY_HANDOFF_DIR>/memory.sqlite`,
# and `hooks/module.js` appends one JSON row per compaction to `index.jsonl`
# beside it. The database is the data; the log is where `via` lives, because
# `generations` has no column for it.
DB = os.path.join(DATA, "memory.sqlite")
INDEX = os.path.join(DATA, "index.jsonl")

# The weights are 166 MB and live outside any plugin root. `MEMORY_HANDOFF_DIR`
# would otherwise point the models directory at the empty scratch dir
# (`runtime/infer.js: defaultModelsDir`), every retrieval would degrade to FTS
# only, and a check measuring the vector arm would be measuring its absence.
# Read-only use of the real ones, so nothing here downloads 166 MB per run.
MODELS = os.environ.get("MEMORY_HANDOFF_MODELS_DIR") or os.path.expanduser("~/.claude/memory-handoff/models")

# The checks that need both plugins loaded, compact-handoff first, so that
# memory-handoff runs through the seam rather than its own `session.compact`.
BOTH_CHECKS = ("compact", "inject")

# The prompt-path checks assert the model got the port from the injected block.
# A model that can call memory_search would find it that way too, so the tools
# are banned in those sessions; `tool` is the check that exercises them.
MEMORY_TOOLS = tuple(f"mcp__memory-handoff__{name}" for name in ("memory_search", "memory_explain", "memory_list", "memory_status", "memory_delete"))

# Two invented facts, verifiable and findable: nothing on this box or in any
# model's weights says which port `orangebox-<n>`'s webhook listens on, so a
# session that answers it read it out of an injected memory rather than out of
# the prompt. They are minted fresh for every `compact`, because the store keeps
# the last pair and hands it back on the facts prompt itself: a fork asked to
# extract facts the session was already handed correctly writes nothing (three
# runs in a row, haiku and sonnet, before this was understood). The latest pair
# is kept in the scratch dir so the later checks ask about what `compact` last
# planted.
FACTS_FILE = os.path.join(SCRATCH, "facts.json")
DEFAULT_FACTS = {"db": "orangebox-7", "port": "8477"}


def mint_facts():
    """A new database name and port no earlier run has used."""
    import random

    facts = {"db": f"orangebox-{random.randint(10, 99)}", "port": str(random.randint(5000, 9899))}
    with open(FACTS_FILE, "w") as handle:
        json.dump(facts, handle)

    return facts


def planted_facts():
    try:
        with open(FACTS_FILE) as handle:
            return json.load(handle)
    except FileNotFoundError:
        return DEFAULT_FACTS


def facts_prompt(facts):
    return (
        f"For this project remember two facts and reply only 'noted': the staging database is called {facts['db']}, "
        f"and its deploy webhook listens on port {facts['port']}."
    )


def port_question(facts):
    return f"What port does the {facts['db']} deploy webhook listen on? Answer with the number only."

# Every table a check reads. Interpolated into SQL by name, so the whitelist is
# the sanitiser: SQLite takes no parameter in an identifier position, and a
# double-quoted identifier that does not resolve is silently a string literal.
TABLES = ("memories", "generations", "costs", "retrievals", "injections")


# ------------------------------------------------------------------ #
# The scratch environment.
# ------------------------------------------------------------------ #


def write_config(directory):
    """A config dir with this box's credentials and none of its behaviour.

    Credentials live inside the config dir, so an empty one cannot log in, and
    a check that cannot log in measures nothing. It is a copy rather than a
    symlink so a session here cannot rewrite the operator's token. `do_run`
    lends it again on every run and deletes it when the run is over, so a
    cleanup between runs is not a trap.

    Auto-compaction is off in the settings as well as in the environment: every
    check here wants the compaction it asked for and nothing else, and an auto
    compaction landing mid-check would write a generation row the check would
    then read as its own.
    """
    os.makedirs(directory, exist_ok=True)

    settings = {
        "autoCompactEnabled": False,
        "includeCoAuthoredBy": False,
        # Without this the TUI stops on the bypass-permissions warning and
        # never reads a keystroke meant for the prompt.
        "bypassPermissionsModeAccepted": True,
        "permissions": {"defaultMode": "bypassPermissions"},
        # Claude Code's own auto-memory wrote the port into the config dir's
        # memory/ during the compact check and loaded it into every later
        # session, which read exactly like an injection. Off, both ways.
        "autoMemoryEnabled": False,
    }

    with open(os.path.join(directory, "settings.json"), "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=2)

    seed_onboarding(directory)

    return copy_credentials(directory)


def copy_credentials(directory):
    """Lend one config dir this box's token, as a copy at mode 600.

    A copy rather than a symlink so a bench session cannot rewrite the
    operator's real token, and short-lived: `do_run` drops it again in a
    `finally`, so it never outlives the run that needed it.
    """
    source = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")

    if not os.path.isfile(source):
        return False

    subprocess.run(["install", "-m", "600", source, os.path.join(directory, ".credentials.json")], check=True)

    return True


def lend_credentials():
    """The bench config dir gets the token for the length of one run.

    This is here because leaving it to `setup` was a trap in the plugin this
    file is modelled on. Credentials live inside the config dir, a check is a
    real interactive session and cannot log in without one, and a run that
    cannot log in does not fail loudly: it comes back empty in milliseconds,
    which reads exactly like a regression in the plugin and is not one. Copying
    is idempotent, so doing it on every run costs nothing.
    """
    return copy_credentials(CONFIG)


def drop_credentials():
    """Take the token back out of the config dir."""
    path = os.path.join(CONFIG, ".credentials.json")

    if os.path.isfile(path):
        os.remove(path)


def seed_onboarding(directory):
    """Enough of the user config that the TUI does not open the login chooser.

    Credentials alone are enough for a headless `claude -p`, but an interactive
    session with no `hasCompletedOnboarding` walks into the auth-method picker
    and sits there until the deadline expires. Only the onboarding flags are
    copied, never the operator's projects and never an MCP server.

    The trust entry is keyed on the scratch project, not on any real checkout:
    without it the TUI opens the trust dialog on first use of that directory and
    waits there forever.
    """
    source = os.path.join(os.path.expanduser("~"), ".claude.json")
    seeded = {
        "hasCompletedOnboarding": True,
        "bypassPermissionsModeAccepted": True,
        "mcpServers": {},
        "projects": {
            PROJECT: {
                "hasTrustDialogAccepted": True,
                "hasClaudeMdExternalIncludesApproved": True,
                "hasClaudeMdExternalIncludesWarningShown": True,
                "allowedTools": [],
                "mcpServers": {},
                "enabledMcpjsonServers": [],
                "disabledMcpjsonServers": [],
            }
        },
    }

    if os.path.isfile(source):
        with open(source, encoding="utf-8") as handle:
            ambient = json.load(handle)

        for key in ("userID", "installMethod", "firstStartTime", "numStartups", "migrationVersion"):
            if key in ambient:
                seeded[key] = ambient[key]

    with open(os.path.join(directory, ".claude.json"), "w", encoding="utf-8") as handle:
        json.dump(seeded, handle, indent=2)


def build_project():
    """A git repository of its own, which is what makes the project key isolated.

    `schema/generation-rows.js: projectKey` takes the normalised git remote
    first, then the git toplevel, then the cwd. This repo deliberately has no
    remote, so the key is this directory: nothing a real checkout writes can be
    retrieved here, and nothing written here can reach a real checkout's
    memories. One commit, because a repository with no HEAD is not one every
    git reading answers for.
    """
    os.makedirs(PROJECT, exist_ok=True)

    with open(os.path.join(PROJECT, "README.md"), "w", encoding="utf-8") as handle:
        handle.write("# verify-684\n\nA scratch project for the memory-handoff integration checks.\n")

    if os.path.isdir(os.path.join(PROJECT, ".git")):
        return PROJECT

    git = ["git", "-c", "user.email=verify@example.invalid", "-c", "user.name=verify", "-C", PROJECT]

    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    subprocess.run([*git, "add", "README.md"], check=True)
    subprocess.run([*git, "commit", "-q", "--no-gpg-sign", "-m", "scratch project"], check=True)

    return PROJECT


def env_for(check, extra=None):
    """The environment one check runs in.

    Auto-compaction is off for every check: the compactions here are the ones a
    check asked for, and an auto compaction would write a generation row that
    the check would then read as the one it caused.
    """
    env = dict(os.environ)
    env["CLAUDE_CONFIG_DIR"] = CONFIG
    env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
    env["MEMORY_HANDOFF_DIR"] = DATA
    env["MEMORY_HANDOFF_LIVE"] = "1"
    env["MEMORY_HANDOFF_MODELS_DIR"] = MODELS
    env["COMPACT_HANDOFF_DATA_DIR"] = CH_DATA
    env["COMPACT_HANDOFF_LIVE"] = "1"
    env["CLAUDE_CODE_VERSION"] = claude_version()
    # A session spawned from inside another one inherits CLAUDE_CODE_CHILD_SESSION
    # and writes no transcript at all, so nothing could be resumed and the plugin
    # would have no conversation to read at compaction time.
    env.pop("CLAUDE_CODE_CHILD_SESSION", None)
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"
    env["DISABLE_AUTO_COMPACT"] = "1"
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"

    env.update(extra or {})

    return env


def claude_version():
    try:
        out = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=30)

        return out.stdout.strip().split()[0]
    except Exception:
        return "unknown"


# ------------------------------------------------------------------ #
# Reading back what the plugin stored.
# ------------------------------------------------------------------ #


def query(sql, params=()):
    """Read the plugin's database without ever being the reason a write failed.

    Read-only through a URI, so this process cannot create the file, cannot
    migrate it and cannot take the write lock off a session that is mid-write.
    WAL is fine read-only as long as the `-wal` and `-shm` files are there,
    which they are: the sessions writing them are this user's.

    An empty list for a database that does not exist yet, because the first
    check runs before anything has ever written one.
    """
    if not os.path.isfile(DB):
        return []

    try:
        conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error:
        return []

    try:
        conn.row_factory = sqlite3.Row

        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def max_id(table):
    """The highest id in one table, or 0 before the table has a row."""
    if table not in TABLES:
        raise ValueError(f"{table} is not one of {', '.join(TABLES)}")

    found = query(f"SELECT COALESCE(MAX(id), 0) AS n FROM {table}")

    return found[0]["n"] if found else 0


def since(table, after):
    """Every row one check caused, oldest first."""
    if table not in TABLES:
        raise ValueError(f"{table} is not one of {', '.join(TABLES)}")

    return query(f"SELECT * FROM {table} WHERE id > ? ORDER BY id", (after,))


def newest(table):
    if table not in TABLES:
        raise ValueError(f"{table} is not one of {', '.join(TABLES)}")

    found = query(f"SELECT * FROM {table} ORDER BY id DESC LIMIT 1")

    return found[0] if found else None


def source_of(row):
    """`memories.source` is JSON, and the writer puts `via` and the session in it."""
    try:
        return json.loads(row.get("source") or "{}")
    except (TypeError, ValueError):
        return {}


def index_rows():
    """The plugin's own log, oldest first.

    `generations` has no `via` column: the writer puts it in `memories.source`
    and on the index row (`hooks/module.js: writeDocument`, `appendRow`). So the
    seam is asserted from those two, not from the generations row.
    """
    if not os.path.isfile(INDEX):
        return []

    found = []

    with open(INDEX, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()

            if not line:
                continue

            try:
                found.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    return found


# ------------------------------------------------------------------ #
# Driving a session.
# ------------------------------------------------------------------ #


def spawn(check, log, env, model=None, ban=()):
    """One fresh interactive session, in the scratch project, with the plugins.

    compact-handoff goes first when a check wants both, because hook-chain order
    is the order the plugin dirs are given and the seam only means anything with
    compact-handoff outermost. Sessions are always fresh: there is no fixture
    transcript here, the conversation a check needs is the one it types.
    """
    argv = ["--plugin-dir", PLUGIN, "--permission-mode", "bypassPermissions"]

    if check in BOTH_CHECKS:
        argv = ["--plugin-dir", COMPACT_HANDOFF, *argv]

    if ban:
        # `--tools ""` takes every built-in tool away, so the model cannot grep
        # the answer off disk (a haiku session did exactly that, and found an
        # old transcript); the plugin's own MCP tools are denied by name.
        argv += ["--tools", "", "--disallowed-tools", *ban]

    if model:
        argv += ["--model", model]

    os.makedirs(LOGS, exist_ok=True)

    child = pexpect.spawn(
        "claude",
        argv,
        cwd=PROJECT,
        env=env,
        timeout=1800,
        dimensions=(50, 160),
        encoding="utf-8",
        codec_errors="replace",
    )
    child.logfile_read = open(os.path.join(LOGS, log), "w", buffering=1)
    accept_bypass(child)

    return child


ESCAPES = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.")


def screen(child, tail=4000):
    """What the TUI has drawn lately, with the escape codes taken out.

    `expect` matches the raw stream, where the TUI can put a colour code in the
    middle of a word, so anything that has to read the screen reads it here.
    Spaces go too: a dialog draws its options padded, the padding varies, and
    the pane's own title line is `Memories  N prompts` with a variable gap.
    """
    child.logfile_read.flush()

    with open(child.logfile_read.name, encoding="utf-8", errors="replace") as handle:
        text = handle.read()[-tail:]

    return ESCAPES.sub("", text).replace(" ", "")


def accept_bypass(child, attempts=4):
    """Clear the bypass-permissions warning, which no settings key suppresses.

    `bypassPermissionsModeAccepted` in the isolated settings.json and in its
    .claude.json both leave the dialog up, and while it is up the TUI eats every
    keystroke meant for the prompt. So answer it: the second choice is
    "Yes, I accept". A session that never shows it just times out here.

    **Confirm the cursor moved before pressing Enter.** Sending the down-arrow
    and Enter blind loses the session outright when the arrow does not land: the
    default choice is "No, exit", so the Enter meant to accept quits instead.
    A whole check has been lost that way - every prompt after it was typed into
    a TUI that was already gone.
    """
    # Not `expect`: that matches the raw stream, and the TUI draws a colour code
    # in the middle of the phrase, so "I accept" is never literally there. The
    # measured shape is `"I accept" in raw` False and `"Yes,Iaccept" in screen()`
    # True, which is why this reads the de-escaped screen instead.
    end = time.time() + 25

    while time.time() < end:
        if "Yes,Iaccept" in screen(child):
            break

        pump(child, 2)
    else:
        return False

    for _ in range(attempts):
        # Only nudge when the cursor is not already there. Two options wrap, so
        # a blind second press can walk it straight back onto "No, exit".
        if "❯Yes,Iaccept" not in screen(child):
            child.send("\x1bOB")
            pump(child, 2)

        if "❯Yes,Iaccept" not in screen(child):
            continue

        child.send("\r")
        pump(child, 4)

        if "Yes,Iaccept" not in screen(child, tail=1500):
            return True

    raise RuntimeError("the bypass dialog would not clear; refusing to type into it")


def pump(child, seconds):
    end = time.time() + seconds

    while time.time() < end:
        try:
            child.expect([pexpect.TIMEOUT], timeout=2)
        except pexpect.EOF:
            return


def say(child, text, settle=2):
    """Type one prompt and submit it, starting from an input box known to be empty.

    The kill-line matters: a `/compact` leaves its own text in the box, so the
    next thing typed becomes `/compact <that text>` and compacts a second time
    with instructions.
    """
    child.send("\x15")
    pump(child, 1)
    child.send(text)
    pump(child, settle)
    child.send("\r")


def warm(child, settle=45):
    """Complete one real turn, because a fork with no warm transcript is null.

    `$.model.fork` reads the main thread's cache-safe snapshot, and a session
    that has answered nothing in this process has none: the generation comes
    back `cold` and writes a row with no memories on it however well the
    dispatch worked.
    """
    say(child, "Reply with only the word ready, and call no tools.")
    pump(child, settle)


def wait_for(child, predicate, deadline, step=5):
    """Pump the session until the rows say so, or until the deadline.

    Every wait in this file goes through here, so no check can hang: the
    deadline is the only exit besides the predicate.
    """
    end = time.time() + deadline

    while time.time() < end:
        pump(child, step)

        if predicate():
            return True

    return False


def quit_session(child):
    try:
        child.send("\x1b")
        pump(child, 2)
        child.send("\x15")
        pump(child, 1)
        child.send("/quit\r")
        pump(child, 5)
    except Exception:
        pass

    child.close(force=True)


def record(name, ok, detail, evidence=None):
    os.makedirs(SCRATCH, exist_ok=True)

    verdict = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "check": name,
        "ok": ok,
        "detail": detail,
        "evidence": evidence or {},
    }

    with open(VERDICTS, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(verdict, default=str) + "\n")

    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)

    return verdict


# ------------------------------------------------------------------ #
# The checks. Each returns a verdict and pays for exactly one session.
# ------------------------------------------------------------------ #


def check_compact(args):
    """A compaction becomes memories, through compact-handoff's seam.

    Both plugins, compact-handoff first, because that is the install this has to
    survive: compact-handoff answers `session.compact` without calling `next`,
    so memory-handoff only sees the compaction through the seam it subscribed
    to at `session.start`. `via` says which path carried it, and it is read off
    `memories.source` and `index.jsonl` rather than off the `generations` row:
    the table has no `via` column, by design, and the writer puts it in the
    memory's `source` JSON instead.
    """
    before = {table: max_id(table) for table in ("memories", "generations", "costs")}
    facts = mint_facts()

    child = spawn("compact", "compact.log", env_for("compact"), model=args.model)

    try:
        pump(child, 45)
        warm(child)

        # Two turns before the compaction: the facts have to be in a finished
        # turn for the fork to read them, and a second short turn makes the
        # conversation more than the one message the fork would be summarising.
        say(child, facts_prompt(facts))
        pump(child, args.turn_settle)

        say(child, "Reply only 'ok'.")
        pump(child, args.turn_settle)

        say(child, "/compact")

        got = wait_for(
            child,
            lambda: max_id("memories") > before["memories"] and max_id("generations") > before["generations"],
            args.deadline,
        )
    finally:
        quit_session(child)

    memories = since("memories", before["memories"])
    generations = since("generations", before["generations"])
    costs = since("costs", before["costs"])
    # The writer starts the embedder detached and does not wait for it; a cold
    # runtime takes a few seconds, so the vectors are read after a short wait.
    time.sleep(15)
    embedded = [
        row["memory_id"]
        for row in query("SELECT memory_id FROM embeddings WHERE memory_id > ?", (before["memories"],))
    ]
    logged = [row for row in index_rows() if row.get("outcome") is not None]
    via = (logged[-1].get("via") if logged else None) or (source_of(memories[0]).get("via") if memories else None)

    if not got or not memories or not generations:
        return record(
            "compact",
            False,
            f"{len(memories)} memory row(s) and {len(generations)} generation row(s) within {args.deadline}s",
            {"via": via, "lastIndexRow": logged[-1] if logged else None},
        )

    generation = generations[-1]
    cost = costs[-1] if costs else None
    # A NULL `usd` is a legitimate answer as long as the row says why: the
    # schema's CHECK allows a price, an unknown with a reason, or a real zero
    # with a note. Silence is the only thing it refuses, so silence fails here.
    priced = cost is not None and (
        cost.get("usd") is not None or cost.get("cost_unknown_reason") or cost.get("cost_note")
    )
    sourced = [row for row in memories if source_of(row).get("sessionId")]
    vectored = len(embedded) == len(memories)
    kept = any(facts["port"] in (row.get("body") or "") for row in memories)
    ok = bool(sourced) and priced and via == "seam" and vectored and kept

    return record(
        "compact",
        ok,
        f"{len(memories)} memory row(s), outcome={generation.get('outcome')}, "
        f"memories_written={generation.get('memories_written')}, via={via}, "
        f"embedded={len(embedded)}/{len(memories)}, port {facts['port']} kept: {kept}, "
        f"${(cost or {}).get('usd')} ({(cost or {}).get('basis')})",
        {
            "memories": [
                {
                    "id": row["id"],
                    "project": row["project"],
                    "type": row["type"],
                    "status": row["status"],
                    "title": row["title"],
                    "source": source_of(row),
                }
                for row in memories
            ],
            "generation": generation,
            "cost": cost,
            "sourcedMemories": len(sourced),
        },
    )


def check_inject(args):
    """A later session is handed those memories at prompt time, and uses them.

    The port is the whole point. Nothing in this session's conversation says
    8477, so a session that answers 8477 read it out of the block memory-handoff
    attached on the way down. Both plugins again, because this is the install
    check 1 wrote its memories under.
    """
    before = {table: max_id(table) for table in ("injections", "retrievals")}
    facts = planted_facts()

    child = spawn("inject", "inject.log", env_for("inject"), model=args.model, ban=MEMORY_TOOLS)

    try:
        pump(child, 45)
        say(child, port_question(facts))

        got = wait_for(child, lambda: max_id("injections") > before["injections"], args.inject_deadline)

        # The row is written after the prompt goes down, so the model may still
        # be answering when it lands. The screen reading needs the answer.
        pump(child, args.turn_settle)
        text = screen(child, tail=8000)
    finally:
        quit_session(child)

    injections = since("injections", before["injections"])
    retrievals = since("retrievals", before["retrievals"])

    if not got or not injections:
        return record("inject", False, f"no injections row within {args.inject_deadline}s", {"retrievals": retrievals})

    injection = injections[-1]
    retrieval = retrievals[-1] if retrievals else None
    answered = facts["port"] in text
    ok = injection.get("entries", 0) >= 1 and (retrieval or {}).get("origin") == "prompt" and answered

    return record(
        "inject",
        ok,
        f"entries={injection.get('entries')}, chars={injection.get('chars')}, "
        f"origin={(retrieval or {}).get('origin')}, returned_n={(retrieval or {}).get('returned_n')}, "
        f"{facts['port']} on screen: {answered}",
        {
            "injection": injection,
            "retrieval": retrieval,
            "degraded": (retrieval or {}).get("degraded"),
            "memoryIds": injection.get("memory_ids"),
        },
    )


def check_tool(args):
    """The model can search the store itself, and the trace says it was a tool.

    `origin` is the assertion: a prompt-time retrieval and a tool call write the
    same shaped row, and only the origin column tells them apart. memory-handoff
    alone here - the seam has nothing to do with a tool call, and a second
    plugin is a second thing to go wrong.
    """
    before = max_id("retrievals")

    child = spawn("tool", "tool.log", env_for("tool"), model=args.model)

    try:
        pump(child, 45)
        say(
            child,
            "Call the memory_search tool with query 'deploy webhook port' and reply with the retrievalId it returns.",
        )

        got = wait_for(
            child,
            lambda: any(row.get("origin") == "tool" for row in since("retrievals", before)),
            args.inject_deadline,
        )
        text = screen(child, tail=8000)
    finally:
        quit_session(child)

    fresh = since("retrievals", before)
    tools = [row for row in fresh if row.get("origin") == "tool"]

    if not got or not tools:
        return record(
            "tool",
            False,
            f"no tool-origin retrieval within {args.inject_deadline}s ({len(fresh)} retrieval row(s) total)",
            {"origins": [row.get("origin") for row in fresh]},
        )

    row = tools[-1]

    return record(
        "tool",
        True,
        f"retrieval {row['id']}: query={row.get('query_text')!r}, returned_n={row.get('returned_n')}, "
        f"{row.get('ms_total')}ms",
        {"retrieval": row, "idEchoed": str(row["id"]) in text},
    )


def check_headless(args):
    """The module loads and answers in a headless session too.

    Generation cannot be checked here: `$.session.compact` refuses headless, so
    a `claude -p` never compacts and never forks. What this check is for is the
    cheaper half - the module loads, registers its tools, and `memory_status`
    answers - which is the thing that silently breaks when a module stops
    loading at all.

    `--setting-sources ""` so this box's own settings layer stays out of it, and
    a hard subprocess timeout because a headless session that wedges would
    otherwise hold the whole run.
    """
    argv = [
        "claude",
        "-p",
        "--plugin-dir",
        PLUGIN,
        "--model",
        args.model,
        "--setting-sources",
        "",
        "--max-turns",
        "3",
        "Call the memory_status tool and repeat its answer verbatim.",
    ]

    try:
        out = subprocess.run(
            argv, cwd=PROJECT, env=env_for("headless"), capture_output=True, text=True, timeout=args.headless_timeout
        )
    except subprocess.TimeoutExpired:
        return record("headless", False, f"no answer within {args.headless_timeout}s", {"argv": argv})

    stdout = out.stdout or ""
    lowered = stdout.lower()
    mentions = any(word in lowered for word in ("memories", "memory.sqlite", "generations", "database"))
    ok = out.returncode == 0 and mentions

    return record(
        "headless",
        ok,
        f"exit {out.returncode}, {len(stdout)} chars, status mentioned the store: {mentions}",
        {"tail": stdout[-1200:], "stderr": (out.stderr or "")[-400:]},
    )


def check_pane(args):
    """The person can see what was injected, in the pane the plugin opens.

    The pane opens on the first injection and never before it, so this check
    has to cause one. `screen()` strips spaces, which is why the title is
    matched as the bare word: the pane draws `Memories  N prompts` with a gap
    whose width depends on the terminal.
    """
    before = max_id("injections")

    child = spawn("pane", "pane.log", env_for("pane"), model=args.model, ban=MEMORY_TOOLS)

    try:
        pump(child, 45)
        say(child, port_question(planted_facts()))

        got = wait_for(child, lambda: max_id("injections") > before, args.inject_deadline)

        # The pane is opened and invalidated after the row is written, so give
        # the render a moment before reading the screen.
        pump(child, 10)
        text = screen(child, tail=8000)
    finally:
        quit_session(child)

    injections = since("injections", before)
    retrieval_id = injections[-1].get("retrieval_id") if injections else None
    titled = "Memories" in text
    id_shown = retrieval_id is not None and str(retrieval_id) in text

    return record(
        "pane",
        titled,
        f"pane title on screen: {titled}, retrieval {retrieval_id} on screen: {id_shown}, injection row: {got}",
        {"retrievalId": retrieval_id, "entries": (injections[-1] if injections else {}).get("entries")},
    )


def check_rehearse(args):
    """With the live switch off, the search still runs and nothing reaches the model.

    That is what rehearsing means, and the README spells out the shape it leaves
    behind: a whole `retrievals` row, because the search really ran, and an
    `injections` row beside it with no ids, no characters, and `dropped` equal
    to everything it found. The model gets nothing, so it cannot answer 8477.

    Only meaningful after `compact` has stored the memory it would otherwise
    have found; `returned_n` in the evidence is how a reader tells a real
    rehearsal from an empty store.
    """
    before = {table: max_id(table) for table in ("injections", "retrievals")}
    facts = planted_facts()
    env = env_for("rehearse", {"MEMORY_HANDOFF_LIVE": "0"})

    child = spawn("rehearse", "rehearse.log", env, model=args.model, ban=MEMORY_TOOLS)

    try:
        pump(child, 45)
        say(child, port_question(facts))

        got = wait_for(child, lambda: max_id("injections") > before["injections"], args.inject_deadline)

        pump(child, args.turn_settle)
        text = screen(child, tail=8000)
    finally:
        quit_session(child)

    injections = since("injections", before["injections"])
    retrievals = since("retrievals", before["retrievals"])

    if not got or not injections:
        return record(
            "rehearse", False, f"no injections row within {args.inject_deadline}s", {"retrievals": retrievals}
        )

    injection = injections[-1]
    retrieval = retrievals[-1] if retrievals else None
    leaked = facts["port"] in text
    ok = injection.get("entries") == 0 and not leaked

    return record(
        "rehearse",
        ok,
        f"entries={injection.get('entries')}, chars={injection.get('chars')}, "
        f"dropped={injection.get('dropped')}, returned_n={(retrieval or {}).get('returned_n')}, "
        f"{facts['port']} leaked to the model: {leaked}",
        {"injection": injection, "retrieval": retrieval},
    )


CHECKS = {
    "compact": check_compact,
    "inject": check_inject,
    "tool": check_tool,
    "headless": check_headless,
    "pane": check_pane,
    "rehearse": check_rehearse,
}


# ------------------------------------------------------------------ #
# Entry points.
# ------------------------------------------------------------------ #


def do_setup(args):
    for directory in (SCRATCH, DATA, CH_DATA, LOGS):
        os.makedirs(directory, exist_ok=True)

    credentials = write_config(CONFIG)
    project = build_project()

    print(f"plugin      {PLUGIN}")
    print(f"seam plugin {COMPACT_HANDOFF}")
    print(f"config      {CONFIG} (credentials copied: {credentials})")
    print(f"project     {project}")
    print(f"data        {DATA} (database {DB})")
    print(f"ch-data     {CH_DATA}")
    print(f"models      {MODELS} (present: {os.path.isdir(MODELS)})")
    print(f"logs        {LOGS}")

    # Credentials are lent per run, never left lying in the scratch config.
    drop_credentials()


def do_run(args):
    names = list(CHECKS) if args.checks == ["all"] else args.checks

    for name in names:
        if name not in CHECKS:
            sys.exit(f"no check named {name}; have {', '.join(CHECKS)}")

    if not os.path.isdir(os.path.join(PROJECT, ".git")):
        sys.exit("no scratch project; run `setup` first")

    print(f"running {len(names)} check(s) against {DB}", flush=True)

    if not lend_credentials():
        sys.exit("no ~/.claude/.credentials.json to lend; these checks are real sessions and cannot log in without one")

    try:
        for name in names:
            print(f"-- {name}", flush=True)

            try:
                CHECKS[name](args)
            except Exception as error:
                record(name, False, f"threw: {error}")
    finally:
        drop_credentials()


def do_table(args):
    if not os.path.isfile(VERDICTS):
        print("no verdicts recorded yet")
        return

    latest = {}

    for line in open(VERDICTS, encoding="utf-8"):
        line = line.strip()

        if line:
            verdict = json.loads(line)
            latest[verdict["check"]] = verdict

    print("| # | check | verdict | what was measured |")
    print("|---|-------|---------|-------------------|")

    for n, name in enumerate(CHECKS, start=1):
        verdict = latest.get(name)

        if not verdict:
            print(f"| {n} | {name} | not run | - |")
            continue

        print(f"| {n} | {name} | {'pass' if verdict['ok'] else 'FAIL'} | {verdict['detail']} |")

    counts = {table: max_id(table) for table in TABLES}
    spend = query("SELECT COALESCE(SUM(usd), 0) AS usd FROM costs")
    total = spend[0]["usd"] if spend else 0

    print("\nrows: " + ", ".join(f"{table} {n}" for table, n in counts.items()))
    print(f"the plugin's own priced spend was ${total:.4f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    setup = sub.add_parser("setup", help="Build the scratch config, data dirs and project.")
    setup.set_defaults(func=do_setup)

    run = sub.add_parser("run", help="Run checks by name, or `all`.")
    run.add_argument("checks", nargs="+", help="Check names, or `all`.")
    run.add_argument("--model", default="claude-haiku-4-5-20251001")
    run.add_argument("--deadline", type=int, default=300, help="Seconds a compaction may take to write its rows.")
    run.add_argument("--inject-deadline", type=int, default=120, help="Seconds a prompt-time row may take.")
    run.add_argument("--turn-settle", type=int, default=45, help="Seconds a plain turn is given to finish.")
    run.add_argument("--headless-timeout", type=int, default=180)
    run.set_defaults(func=do_run)

    table = sub.add_parser("table", help="Print the latest verdict for every check.")
    table.set_defaults(func=do_table)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
