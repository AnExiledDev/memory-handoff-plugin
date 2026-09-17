"""Grading a generation against a fixture's checklist.

The pure half of the bench: reading a checklist, building the grader's prompt,
reading its verdicts back and turning them into a number. Nothing here runs a
model or touches the network, so every rule below can be argued about without
spending anything; `run.py` is the adapter that calls a model with it.

Python 3.10, standard library only.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Iterable

#: What each verdict is worth. A wrong memory is not a missing one: it is worse,
#: because a later session acts on it. Carried over from compact-handoff's bench,
#: where the same scale graded handoffs.
POINTS = {"present": 1.0, "partial": 0.5, "absent": 0.0, "wrong": -1.0}

VERDICTS = tuple(POINTS)

_ROW = re.compile(r"^-\s+`(?P<id>[^`]+)`\s*\|\s*(?P<middle>[^|]+?)\s*\|\s*(?P<text>.+?)\s*$")


@dataclass(frozen=True)
class Atom:
    """One fact the transcript establishes, small enough to judge in one word."""

    id: str
    type: str
    text: str


@dataclass(frozen=True)
class Decoy:
    """A literal needle that must not appear in any memory, and why."""

    id: str
    needle: str
    why: str


@dataclass(frozen=True)
class Checklist:
    atoms: tuple[Atom, ...]
    decoys: tuple[Decoy, ...]


def read_checklist(text: str) -> Checklist:
    """Reads the `## Atoms` and `## Decoys` tables and ignores the prose."""
    section = None
    atoms: list[Atom] = []
    decoys: list[Decoy] = []

    for line in text.splitlines():
        heading = line.strip().lower()

        if heading.startswith("## "):
            section = heading[3:].strip()
            continue

        matched = _ROW.match(line.strip())

        if matched is None or section not in {"atoms", "decoys"}:
            continue

        if section == "atoms":
            atoms.append(Atom(matched["id"], matched["middle"], matched["text"]))
        else:
            decoys.append(Decoy(matched["id"], matched["middle"], matched["text"]))

    return Checklist(tuple(atoms), tuple(decoys))


def grader_prompt(atoms: Iterable[Atom], memories: list[dict]) -> str:
    """The grader's whole instruction, carrying no hint of which arm wrote this.

    The grader never sees the generation prompt, the arm name or the replicate
    number, because a grader that knows which arm it is looking at is measuring
    its own expectations.
    """
    listed = "\n".join(f"{atom.id}. {atom.text}" for atom in atoms)
    written = "\n".join(
        f"- [{row.get('type')}] {row.get('title')}: {row.get('body')}" for row in memories
    ) or "(the set is empty)"

    return f"""You are grading a set of notes somebody wrote about a working session, against a list of the facts that session established. You did not see the session and you do not need to: judge only whether each fact below is carried by the notes.

The facts:

{listed}

The notes that were written:

{written}

For every fact, answer with exactly one verdict:

- `present` - a note carries this fact, and a reader of the notes alone would know it.
- `partial` - a note gestures at it but leaves out the part that makes it useful (the number, the reason, the condition).
- `absent` - no note carries it.
- `wrong` - a note states something that contradicts this fact. Only use `wrong` when you can quote both: what the fact says and what the note says instead. If you cannot quote both, the verdict is `absent` or `partial`, never `wrong`.

Answer with one JSON object and nothing else:

{{"verdicts": [{{"id": "U1", "verdict": "present", "fact_says": null, "note_says": null}}]}}

`fact_says` and `note_says` are required on a `wrong` verdict and null everywhere else. Include every id exactly once."""


def read_verdicts(text: str, atoms: Iterable[Atom]) -> dict[str, str]:
    """The grader's answer, read defensively: an id it skipped is `absent`.

    A `wrong` that does not quote both sides is downgraded. Graders reach for
    `wrong` when a note is merely vague, and one unearned `wrong` moves the score
    by a point and a half.
    """
    graded = {atom.id: "absent" for atom in atoms}
    parsed = _first_json_object(text)

    for entry in (parsed or {}).get("verdicts", []):
        if not isinstance(entry, dict):
            continue

        identifier = str(entry.get("id", ""))
        verdict = str(entry.get("verdict", "")).strip().lower()

        if identifier not in graded or verdict not in VERDICTS:
            continue

        if verdict == "wrong" and not (entry.get("fact_says") and entry.get("note_says")):
            verdict = "partial"

        graded[identifier] = verdict

    return graded


def score(verdicts: dict[str, str]) -> dict:
    """Recall as the mean of the verdict points, plus the counts behind it."""
    counts = {name: sum(1 for verdict in verdicts.values() if verdict == name) for name in VERDICTS}
    points = sum(POINTS[verdict] for verdict in verdicts.values())

    return {
        "atoms": len(verdicts),
        "points": round(points, 3),
        "recall": round(points / len(verdicts), 4) if verdicts else 0.0,
        "counts": counts,
    }


def count_decoys(memories: list[dict], decoys: Iterable[Decoy]) -> list[dict]:
    """Which forbidden needles the notes carry, matched rather than judged.

    Case-insensitive substring over title and body. No model is asked, because a
    decoy is a fact about the text and a grader would only add variance to it.
    """
    haystack = "\n".join(f"{row.get('title', '')}\n{row.get('body', '')}" for row in memories).lower()

    return [
        {"id": decoy.id, "needle": decoy.needle, "why": decoy.why}
        for decoy in decoys
        if decoy.needle.lower() in haystack
    ]


def spread(values: list[float]) -> dict:
    """Min, max and mean. Two replicates do not earn a standard deviation."""
    if not values:
        return {"mean": 0.0, "min": 0.0, "max": 0.0, "spread": 0.0}

    return {
        "mean": round(sum(values) / len(values), 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
        "spread": round(max(values) - min(values), 4),
    }


def grade(memories: list[dict], checklist: Checklist, ask: Callable[[str], str]) -> dict:
    """One replicate graded, with the model call injected rather than made here."""
    reply = ask(grader_prompt(checklist.atoms, memories))
    verdicts = read_verdicts(reply, checklist.atoms)

    return {
        "verdicts": verdicts,
        **score(verdicts),
        "decoys": count_decoys(memories, checklist.decoys),
    }


def _first_json_object(text: str) -> dict | None:
    """The first balanced `{...}` in the reply, so a fenced answer still reads."""
    depth = 0
    start = -1

    for index, character in enumerate(text):
        if character == "{":
            if depth == 0:
                start = index

            depth += 1
        elif character == "}" and depth > 0:
            depth -= 1

            if depth == 0:
                try:
                    return json.loads(text[start : index + 1])
                except json.JSONDecodeError:
                    start = -1

    return None
