#!/usr/bin/env python3
"""Runs one prompt arm over one fixture and grades what comes back.

    python3 bench/run.py --fixture ledgerctl --repeat 2 --arm v1 \\
        --model claude-opus-5 --grader claude-sonnet-5

Each replicate is one headless `claude -p` call carrying the fixture transcript
and the arm's prompt, parsed by the plugin's own parser (`bun
hooks/parse-cli.js`, never a second parser written in Python), then graded blind
against the fixture's checklist by a second model.

Two things this deliberately is not. It is not a compaction: the real hook forks
the live session, and a headless call reading a transcript as a user message is
an approximation of that, which is why the fork's output ceiling cannot be
measured here. And it is not a reproducible number: a fork of the same
transcript varies, which is what `--repeat` is for. Replicates run one at a
time because this box has 7.9 GB of RAM and OOMs.

Results land in `bench/.runs/` (gitignored). Python 3.10, standard library only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from grade import Checklist, count_decoys, grade, read_checklist, spread  # noqa: E402

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
RUNS = HERE / ".runs"

#: The generation gets the whole transcript, so it needs room; the grader reads
#: a checklist and a short set of notes.
GENERATE_TIMEOUT_S = 480
GRADE_TIMEOUT_S = 300


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    fixture = fixture_dir(args.fixture)
    checklist = read_checklist((fixture / "checklist.md").read_text(encoding="utf-8"))
    transcript = (fixture / "transcript.md").read_text(encoding="utf-8")
    prompt = (HERE / "prompts" / f"{args.arm}.txt").read_text(encoding="utf-8")

    print(f"arm {args.arm}, fixture {fixture.name}, {args.repeat} replicate(s), "
          f"model {args.model}, grader {args.grader}")
    print(f"{len(checklist.atoms)} atoms, {len(checklist.decoys)} decoys")

    replicates = []

    for index in range(args.repeat):
        print(f"\n-- replicate {index + 1} of {args.repeat}")
        replicates.append(run_replicate(index, transcript, prompt, checklist, args))

    report = summarise(args, fixture, checklist, replicates)
    written = write_report(report)

    print(f"\n{summary_lines(report)}\nwritten to {written}")

    # A replicate the grader never scored is missing from the mean, and a mean
    # over fewer replicates than were paid for is not the number asked for.
    if report["ungraded"]:
        print(f"UNGRADED: {report['ungraded']} of {args.repeat} replicate(s) have no grade; the mean above skips them")

        return 1

    return 0


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)

    parser.add_argument("--fixture", required=True, help="a directory under bench/fixtures, or a path to one")
    parser.add_argument("--repeat", type=int, default=2, help="replicates, run one at a time")
    parser.add_argument("--arm", default="v1", help="a file in bench/prompts, without the .txt")
    parser.add_argument("--model", default="claude-opus-5", help="the model that writes the memories")
    parser.add_argument("--grader", default="claude-sonnet-5", help="the model that grades them, blind")

    return parser.parse_args(argv)


def fixture_dir(name: str) -> Path:
    direct = Path(name)

    return direct if direct.is_dir() else HERE / "fixtures" / name


def run_replicate(index: int, transcript: str, prompt: str, checklist: Checklist, args) -> dict:
    """One generation, parsed and graded, with everything it cost recorded."""
    generation = ask_claude(f"{transcript}\n\n---\n\n{prompt}", args.model, GENERATE_TIMEOUT_S)

    if generation["text"] is None:
        print(f"   the model call failed: {generation['error']}")

        return {"index": index, "generation": generation, "parse": None, "grade": None}

    parsed = parse_reply(generation["text"])
    memories = parsed.get("rows", [])

    print(f"   {len(memories)} memories, {len(parsed.get('rejected', []))} rejected, "
          f"cap {parsed.get('hitCap')}, ${generation['usd']:.4f}")

    if not memories:
        return {
            "index": index,
            "generation": generation,
            "parse": parsed,
            "grade": None,
            "decoys": count_decoys(memories, checklist.decoys),
        }

    graded_costs: list[dict] = []

    def ask(grader_prompt: str) -> str:
        answered = ask_claude(grader_prompt, args.grader, GRADE_TIMEOUT_S)

        graded_costs.append(answered)

        return answered["text"] or ""

    graded = grade(memories, checklist, ask)
    graded["cost"] = graded_costs[0] if graded_costs else None

    print(f"   recall {graded['recall']:.3f}  {graded['counts']}")
    print(f"   decoys {len(graded['decoys'])}: "
          f"{', '.join(hit['needle'] for hit in graded['decoys']) or 'none'}")

    return {"index": index, "generation": generation, "parse": parsed, "grade": graded}


def ask_claude(prompt: str, model: str, timeout_s: int) -> dict:
    """One headless call, in an empty directory so nothing on this box leaks in.

    `--setting-sources ""` alone does not stop a `CLAUDE.md` beside the process
    being read, so the working directory is an empty temp one. The MCP flags cut
    every server for the same reason: the arm is what is being measured, not
    whatever this machine happens to have installed.
    """
    argv = [
        "claude", "-p",
        "--max-turns", "1",
        "--model", model,
        "--output-format", "json",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "",
    ]
    started = time.monotonic()

    with tempfile.TemporaryDirectory(prefix="memory-bench-") as empty:
        try:
            ran = subprocess.run(
                argv, input=prompt, capture_output=True, text=True, timeout=timeout_s, cwd=empty,
            )
        except subprocess.TimeoutExpired:
            return blank(model, time.monotonic() - started, f"timed out after {timeout_s}s")

    if ran.returncode != 0:
        return blank(model, time.monotonic() - started, f"exit {ran.returncode}: {ran.stderr.strip()[:400]}")

    try:
        answer = json.loads(ran.stdout)
    except json.JSONDecodeError:
        return blank(model, time.monotonic() - started, f"unreadable answer: {ran.stdout.strip()[:400]}")

    return {
        "model": model,
        "text": answer.get("result"),
        "usd": float(answer.get("total_cost_usd") or 0.0),
        "usage": answer.get("usage"),
        "turns": answer.get("num_turns"),
        "elapsed_s": round(time.monotonic() - started, 2),
        "error": None if answer.get("result") is not None else f"no result field (subtype {answer.get('subtype')})",
    }


def blank(model: str, elapsed: float, error: str) -> dict:
    return {"model": model, "text": None, "usd": 0.0, "usage": None, "turns": None,
            "elapsed_s": round(elapsed, 2), "error": error}


def parse_reply(text: str) -> dict:
    """The plugin's parser, shelled, so the bench cannot disagree with the hook."""
    ran = subprocess.run(
        ["bun", str(PLUGIN / "hooks" / "parse-cli.js")],
        input=text, capture_output=True, text=True, timeout=120,
    )

    if ran.returncode != 0:
        return {"rows": [], "rejected": [{"line": 0, "reason": f"parser exited {ran.returncode}"}],
                "hitCap": None, "hadBlock": False}

    return json.loads(ran.stdout)


def summarise(args, fixture: Path, checklist: Checklist, replicates: list[dict]) -> dict:
    recalls = [row["grade"]["recall"] for row in replicates if row.get("grade")]
    decoys = [len(row["grade"]["decoys"]) if row.get("grade") else len(row.get("decoys", []))
              for row in replicates]
    usd = sum(row["generation"]["usd"] for row in replicates)
    usd += sum(row["grade"]["cost"]["usd"] for row in replicates
               if row.get("grade") and row["grade"].get("cost"))

    return {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "arm": args.arm,
        "fixture": fixture.name,
        "model": args.model,
        "grader": args.grader,
        "atoms": len(checklist.atoms),
        "recall": spread(recalls),
        "ungraded": len(replicates) - len(recalls),
        "decoys_per_replicate": decoys,
        "memories_per_replicate": [len(row["parse"]["rows"]) if row.get("parse") else 0 for row in replicates],
        "usd": round(usd, 4),
        "replicates": replicates,
    }


def summary_lines(report: dict) -> str:
    recall = report["recall"]

    return "\n".join([
        f"recall  mean {recall['mean']:.3f}  min {recall['min']:.3f}  max {recall['max']:.3f}  "
        f"spread {recall['spread']:.3f}  over {report['atoms']} atoms",
        f"decoys  {report['decoys_per_replicate']} (one number per replicate; zero is the bar)",
        f"memories {report['memories_per_replicate']}",
        f"cost    ${report['usd']:.4f} for the whole run, generation and grading",
    ])


def write_report(report: dict) -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    stamp = report["at"].replace(":", "").replace("-", "")
    path = RUNS / f"{stamp}-{report['fixture']}-{report['arm']}.json"

    path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return path


if __name__ == "__main__":
    raise SystemExit(main())
