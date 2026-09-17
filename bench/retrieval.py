#!/usr/bin/env python3
"""Grades retrieval against a labelled query set, hybrid and lexical-only.

    python3 bench/retrieval.py
    python3 bench/retrieval.py --no-runtime

Seeds a fresh store through `bun test/seed-retrieval.js`, runs every query in
`bench/fixtures/retrieval/queries.json` through `bun retrieval/search-cli.js`,
and prints hit@1, hit@k, MRR, the wrong-project leak count and a per-query
table. The default run does it twice over: once hybrid, once with
`--no-runtime`, so the vector arm's contribution is a column and not a claim.

Nothing here reimplements retrieval. The queries go through the same CLI a
person would type, and the labels are titles the seed wrote, looked up in the
seeded database so a renamed memory breaks the bench loudly rather than
grading nothing.

Each arm's whole set is run twice and the two runs' stdout compared byte for
byte, because determinism is a stated property of `search()` rather than an
accident of the sort order. A hybrid run that came back `degraded` is reported
as degraded and exits non-zero: FTS5 numbers printed under a hybrid heading
would be the wrong measurement, quietly. One query carries `allow_degraded`
because it degrades by design rather than by accident (a pasted log costs more
rerank time than the shipped ceiling gives it); its degradation is printed,
graded and excluded from that check, and nothing else's is.

The corpus is synthetic: ~50 seeded memories over two projects, written to
exercise the arms. It says nothing about real conversations.

Queries run one at a time. This box has 7.9 GB of RAM and OOMs under parallel
load. Python 3.10, standard library only, like `bench/run.py`.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
RUNS = HERE / ".runs"
QUERIES = HERE / "fixtures" / "retrieval" / "queries.json"

#: The seed embeds ~50 memories through the real runtime, which includes a cold
#: model load on the first call.
SEED_TIMEOUT_S = 600

#: One query: a bun start, two arms and one rerank call.
QUERY_TIMEOUT_S = 120


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    spec = json.loads(Path(args.queries).read_text(encoding="utf-8"))
    queries = spec["queries"]

    print(f"{len(queries)} queries, k={args.k}, seed {spec['seed']}")

    with tempfile.TemporaryDirectory(prefix="memory-retrieval-bench-") as workspace:
        db = Path(workspace) / "retrieval-fixture.db"

        seed(db)

        memories = read_memories(db)
        unknown = unknown_labels(queries, memories)

        if unknown:
            for line in unknown:
                print(f"  {line}")

            print(f"\n{len(unknown)} label(s) name a memory the seed did not write. The fixture and the seed have diverged.")

            return 1

        arms = [False] if args.no_runtime else [True, False]
        reports = [run_arm(db, queries, hybrid, args, memories) for hybrid in arms]

    for report in reports:
        print(f"\n{'=' * 78}\n{heading(report)}\n{'=' * 78}")
        print(per_query_table(report))
        print(f"\n{summary_lines(report)}")

    if len(reports) > 1:
        print(f"\n{'=' * 78}\nhybrid against lexical-only\n{'=' * 78}")
        print(comparison_table(reports))

    written = write_report(spec, args, reports)

    print(f"\nwritten to {written}")

    return exit_code(reports)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)

    parser.add_argument("--no-runtime", action="store_true", help="lexical-only, the degraded rung, and nothing else")
    parser.add_argument("--k", type=int, default=5, help="results per query; the injection block's size")
    parser.add_argument("--queries", default=str(QUERIES), help="a labelled query set, defaults to the one in bench/fixtures")
    parser.add_argument("--runtime-timeout-ms", type=int, default=None,
                        help="the ceiling on one runtime call; the CLI's own default when unset, which is what a prompt gets")

    return parser.parse_args(argv)


def seed(db: Path) -> None:
    """A fresh store per run. The seed refuses an existing path, deliberately."""
    print(f"seeding {db}")

    ran = subprocess.run(
        ["bun", str(PLUGIN / "test" / "seed-retrieval.js"), str(db)],
        capture_output=True, text=True, timeout=SEED_TIMEOUT_S, cwd=PLUGIN,
    )

    if ran.returncode != 0:
        raise SystemExit(f"the seed failed (exit {ran.returncode}):\n{ran.stdout}\n{ran.stderr}")

    print(ran.stdout.strip().splitlines()[-1])


def read_memories(db: Path) -> dict[int, dict]:
    """Every seeded memory by id, so a returned row can be attributed to a project and a status."""
    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    try:
        rows = connection.execute("SELECT id, project, title, status FROM memories").fetchall()
    finally:
        connection.close()

    return {row[0]: {"project": row[1], "title": row[2], "status": row[3]} for row in rows}


def unknown_labels(queries: list[dict], memories: dict[int, dict]) -> list[str]:
    """Labels naming a memory nobody wrote, which would grade as a permanent miss."""
    by_project: dict[str, set[str]] = {}
    everywhere: set[str] = set()

    for memory in memories.values():
        by_project.setdefault(memory["project"], set()).add(memory["title"])
        everywhere.add(memory["title"])

    unknown = []

    for query in queries:
        known = by_project.get(query["project"], set())

        for title in query.get("relevant", []) + query.get("partial", []):
            if title not in known:
                unknown.append(f"{query['id']}: no memory titled {title!r} under {query['project']}")

        for title in query.get("must_not", []):
            if title not in everywhere:
                unknown.append(f"{query['id']}: no memory titled {title!r} anywhere, so it can never leak")

    return unknown


def run_arm(db: Path, queries: list[dict], hybrid: bool, args, memories: dict[int, dict]) -> dict:
    """One whole query set, run twice and graded once."""
    arm = "hybrid" if hybrid else "lexical-only"

    print(f"\n-- {arm}: {len(queries)} queries, twice (the second run is the determinism check)")

    first = [ask(db, query, hybrid, args) for query in queries]
    second = [ask(db, query, hybrid, args) for query in queries]
    drift = [query["id"] for query, a, b in zip(queries, first, second) if a["stdout"] != b["stdout"]]

    graded = [grade(query, answer, memories) for query, answer in zip(queries, first)]

    note_truncation(db, queries, first, graded)

    return {
        "arm": arm,
        "hybrid": hybrid,
        "k": args.k,
        "drift": drift,
        "queries": graded,
        **aggregate(graded),
    }


def ask(db: Path, query: dict, hybrid: bool, args) -> dict:
    """One retrieval through the CLI, with the query on stdin like every real caller.

    The retrieval id is on stderr and never on stdout, which is what makes two
    runs comparable byte for byte; it is picked back off stderr here because the
    trace is the only place a truncation is recorded.
    """
    argv = [
        "bun", str(PLUGIN / "retrieval" / "search-cli.js"), str(db),
        "--project", query["project"],
        "--query-stdin",
        "--k", str(args.k),
    ]

    if not hybrid:
        argv.append("--no-runtime")

    if args.runtime_timeout_ms is not None:
        argv += ["--runtime-timeout-ms", str(args.runtime_timeout_ms)]

    ran = subprocess.run(
        argv, input=query["query"], capture_output=True, text=True, timeout=QUERY_TIMEOUT_S, cwd=PLUGIN,
    )

    if ran.returncode != 0:
        raise SystemExit(f"{query['id']}: the search exited {ran.returncode}: {ran.stderr.strip()[:400]}")

    answer = json.loads(ran.stdout)

    return {"stdout": ran.stdout, "answer": answer, "retrieval_id": retrieval_id_of(ran.stderr)}


def note_truncation(db: Path, queries: list[dict], answers: list[dict], graded: list[dict]) -> None:
    """Whether a prompt past the embedder's window was recorded as cut, read off the trace.

    The result is graded either way: a truncated query is still a query. What
    would be wrong is the cut happening silently, so the trace is the thing
    checked here rather than the result.
    """
    wanted = [(query, answer, row) for query, answer, row in zip(queries, answers, graded) if query.get("expect_truncated")]

    if not wanted:
        return

    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    try:
        for _, answer, row in wanted:
            filters = connection.execute("SELECT filters FROM retrievals WHERE id = ?", (answer["retrieval_id"],)).fetchone()
            row["met"] = bool(json.loads(filters[0]).get("query_truncated")) if filters else False
    finally:
        connection.close()


def retrieval_id_of(stderr: str) -> int | None:
    for line in stderr.splitlines():
        if line.startswith("retrieval "):
            return int(line.split()[1])

    return None


def grade(query: dict, answer: dict, memories: dict[int, dict]) -> dict:
    """One query's verdict: where the first relevant memory landed, and what leaked.

    A leak is any row the query's own labels forbid, plus anything the pipeline
    forbids everywhere: another project's memory, or a superseded one. The
    second half is checked against the database rather than the fixture, so a
    leak nobody thought to label still counts.
    """
    results = answer["answer"]["results"]
    titles = [row["title"] for row in results]
    relevant = query.get("relevant", [])

    rank = next((index + 1 for index, title in enumerate(titles) if title in relevant), None)
    forbidden = set(query.get("must_not", []))
    leaks = []

    for row in results:
        memory = memories.get(row["memoryId"], {})

        if row["title"] in forbidden:
            leaks.append({"title": row["title"], "why": "labelled must-not for this query"})
        elif memory.get("project") not in (None, query["project"]):
            leaks.append({"title": row["title"], "why": f"belongs to {memory['project']}"})
        elif memory.get("status") not in (None, "active"):
            leaks.append({"title": row["title"], "why": f"status {memory['status']}"})

    graded = {
        "id": query["id"],
        "shape": query.get("shape", ""),
        "project": query["project"],
        "degraded": answer["answer"]["degraded"],
        "degradation_allowed": bool(query.get("allow_degraded")),
        "returned": len(results),
        "top": titles[0] if titles else None,
        "titles": titles,
        "rank": rank,
        "leaks": leaks,
        "scored": bool(relevant),
    }

    if query.get("expect_empty"):
        graded["expectation"] = "empty"
        graded["met"] = len(results) == 0
    elif query.get("expect_truncated"):
        graded["expectation"] = "truncated"
        graded["met"] = None
    else:
        graded["expectation"] = None
        graded["met"] = None

    return graded


def aggregate(graded: list[dict]) -> dict:
    """hit@1, hit@k and MRR over the queries that have a relevant memory to find.

    A query whose whole expectation is an empty result has nothing to rank, so
    it is counted in its own line rather than folded into a mean it would drag.
    """
    scored = [row for row in graded if row["scored"]]
    at_one = sum(1 for row in scored if row["rank"] == 1)
    anywhere = sum(1 for row in scored if row["rank"] is not None)
    reciprocal = [1 / row["rank"] for row in scored if row["rank"] is not None]
    expected = [row for row in graded if row["expectation"] == "empty"]
    truncated = [row for row in graded if row["expectation"] == "truncated"]

    return {
        "truncation_met": sum(1 for row in truncated if row["met"]),
        "truncation_n": len(truncated),
        "scored_n": len(scored),
        "hit1": at_one / len(scored) if scored else 0.0,
        "hitk": anywhere / len(scored) if scored else 0.0,
        "mrr": sum(reciprocal) / len(scored) if scored else 0.0,
        "leaks": sum(len(row["leaks"]) for row in graded),
        "degraded_n": sum(1 for row in graded if row["degraded"] is not None),
        "degraded_unexpected": [row["id"] for row in graded if row["degraded"] is not None and not row["degradation_allowed"]],
        "expectations_met": sum(1 for row in expected if row["met"]),
        "expectations_n": len(expected),
        "misses": [row["id"] for row in scored if row["rank"] is None],
    }


def heading(report: dict) -> str:
    return f"{report['arm']}  (k={report['k']}, {report['scored_n']} scored queries)"


def per_query_table(report: dict) -> str:
    lines = [
        f"{'query':<26} {'shape':<17} {'rank':>4}  {'RR':>5}  {'leak':>4}  top result",
        f"{'-' * 26} {'-' * 17} {'-' * 4}  {'-' * 5}  {'-' * 4}  {'-' * 40}",
    ]

    for row in report["queries"]:
        rank = "-" if row["rank"] is None else str(row["rank"])
        reciprocal = "" if row["rank"] is None else f"{1 / row['rank']:.3f}"

        if not row["scored"]:
            rank = "n/a"
            reciprocal = "pass" if row["met"] else "FAIL"

        lines.append(
            f"{row['id']:<26} {row['shape']:<17} {rank:>4}  {reciprocal:>5}  "
            f"{len(row['leaks']):>4}  {(row['top'] or '(nothing returned)')[:40]}"
        )

    return "\n".join(lines)


def summary_lines(report: dict) -> str:
    return "\n".join([
        f"hit@1   {report['hit1']:.3f}",
        f"hit@{report['k']}   {report['hitk']:.3f}",
        f"MRR     {report['mrr']:.3f}",
        f"leaks   {report['leaks']} (a wrong-project, superseded or labelled must-not row in any result list)",
        f"empty   {report['expectations_met']}/{report['expectations_n']} stopword-only prompts returned nothing",
        f"cut     {report['truncation_met']}/{report['truncation_n']} over-long prompts recorded query_truncated on the trace",
        f"missed  {', '.join(report['misses']) or 'none'}",
        f"drift   {', '.join(report['drift']) or 'none (two runs, byte-identical)'}",
        f"degraded {report['degraded_n']} of {len(report['queries'])} queries{unexpected_degradations(report)}",
    ])


def unexpected_degradations(report: dict) -> str:
    """Only the hybrid arm can degrade unexpectedly: the other one is the degraded rung."""
    if not report["hybrid"] or not report["degraded_unexpected"]:
        return ""

    return f", unexpectedly on {', '.join(report['degraded_unexpected'])}"


def comparison_table(reports: list[dict]) -> str:
    lines = [
        f"{'arm':<14} {'hit@1':>7} {'hit@k':>7} {'MRR':>7} {'leaks':>7} {'misses':>7}",
        f"{'-' * 14} {'-' * 7} {'-' * 7} {'-' * 7} {'-' * 7} {'-' * 7}",
    ]

    for report in reports:
        lines.append(
            f"{report['arm']:<14} {report['hit1']:>7.3f} {report['hitk']:>7.3f} "
            f"{report['mrr']:>7.3f} {report['leaks']:>7} {len(report['misses']):>7}"
        )

    return "\n".join(lines)


def write_report(spec: dict, args, reports: list[dict]) -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)

    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    document = {
        "at": at,
        "k": args.k,
        "queries_file": str(Path(args.queries)),
        "seed": spec["seed"],
        "corpus": "synthetic: the memories test/seed-retrieval.js writes, two projects",
        "arms": reports,
    }
    path = RUNS / f"{at.replace(':', '').replace('-', '')}-retrieval.json"

    path.write_text(json.dumps(document, indent=2), encoding="utf-8")

    return path


def exit_code(reports: list[dict]) -> int:
    """Non-zero for anything that makes the numbers above a lie, not for a low score."""
    failures = []

    for report in reports:
        if report["drift"]:
            failures.append(f"{report['arm']}: {len(report['drift'])} quer(y/ies) differed between two identical runs: {', '.join(report['drift'])}")

        if report["hybrid"] and report["degraded_unexpected"]:
            degraded = {row["degraded"] for row in report["queries"] if row["degraded"] and not row["degradation_allowed"]}
            failures.append(f"hybrid: {len(report['degraded_unexpected'])} quer(y/ies) came back degraded ({'; '.join(sorted(degraded))}); these are not hybrid numbers")

        if report["leaks"]:
            failures.append(f"{report['arm']}: {report['leaks']} leak(s); a memory the filter had to exclude was returned")

        if report["expectations_met"] != report["expectations_n"]:
            failures.append(f"{report['arm']}: a stopword-only prompt returned memories")

        if report["truncation_met"] != report["truncation_n"]:
            failures.append(f"{report['arm']}: a prompt past the embedder's window was cut without the trace saying so")

    for failure in failures:
        print(f"FAILED {failure}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
