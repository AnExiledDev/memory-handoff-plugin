"""The Python comparison arm: is there a genuinely faster, smaller runtime than Bun?

The operator's instruction on 2026-09-16 was "For runtime use bun unless there is a
genuinly faster smaller option", so this exists to make that a measured claim rather
than a preference. It runs the same bge-small graph through the `onnxruntime` and
`numpy` that were already on the box, with a WordPiece tokenizer written here in about
eighty lines, and prints RSS and latency in the same shapes `runtime/bench.js` prints.

It installs nothing. `tokenizers` and `transformers` are not on this box and this file
is the reason they do not need to be.

It covers the embedding model only. The reranker's tokenizer is byte-level BPE rather
than WordPiece, so a Python arm for it means a second hand-written tokenizer, and the
question this answers is settled by the embedding half.

    python3 runtime/compare/python/embed_bench.py [--runs 10]
"""

import argparse
import json
import os
import resource
import time
import unicodedata

import numpy as np
import onnxruntime as ort

MODEL_ID = "BAAI/bge-small-en-v1.5"
MAX_TOKENS = 512
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

# The same pin runtime/infer.js applies, for the same reason: this box has six
# cores shared with a five-minute monitor tick and a Laravel container.
INTRA_OP_THREADS = 2


def models_dir() -> str:
    override = os.environ.get("MEMORY_HANDOFF_MODELS_DIR", "").strip()
    if override:
        return override.rstrip("/")

    root = os.environ.get("MEMORY_HANDOFF_DIR", "").strip().rstrip("/")
    if not root:
        root = os.path.join(os.environ.get("HOME", ""), ".claude", "memory-handoff")

    return os.path.join(root, "models")


class WordPiece:
    """BERT's uncased WordPiece, enough of it to reproduce bge's own tokenization.

    Lowercase, strip accents, split on punctuation, then greedy longest-match against
    the vocabulary with `##` continuations. Anything unmatched becomes [UNK], which is
    what the reference tokenizer does too.
    """

    def __init__(self, vocab_path: str) -> None:
        with open(vocab_path, encoding="utf-8") as handle:
            self.vocab = {line.rstrip("\n"): index for index, line in enumerate(handle)}

        self.unk = self.vocab["[UNK]"]
        self.cls = self.vocab["[CLS]"]
        self.sep = self.vocab["[SEP]"]
        self.pad = self.vocab["[PAD]"]

    def encode(self, text: str) -> list[int]:
        ids = [self.cls]

        for word in self._basic(text):
            ids.extend(self._pieces(word))

        ids = ids[: MAX_TOKENS - 1]
        ids.append(self.sep)

        return ids

    def _basic(self, text: str) -> list[str]:
        stripped = "".join(
            char
            for char in unicodedata.normalize("NFD", text.lower())
            if unicodedata.category(char) != "Mn"
        )
        words: list[str] = []
        current = ""

        for char in stripped:
            if char.isspace():
                if current:
                    words.append(current)
                current = ""
            elif not char.isalnum():
                if current:
                    words.append(current)
                current = ""
                words.append(char)
            else:
                current += char

        if current:
            words.append(current)

        return words

    def _pieces(self, word: str) -> list[int]:
        if word in self.vocab:
            return [self.vocab[word]]

        pieces: list[int] = []
        start = 0

        while start < len(word):
            end = len(word)
            found = None

            while end > start:
                candidate = word[start:end] if start == 0 else "##" + word[start:end]
                if candidate in self.vocab:
                    found = self.vocab[candidate]
                    break
                end -= 1

            if found is None:
                return [self.unk]

            pieces.append(found)
            start = end

        return pieces


def batch(tokenizer: WordPiece, texts: list[str]) -> dict[str, np.ndarray]:
    rows = [tokenizer.encode(text) for text in texts]
    width = max(len(row) for row in rows)
    ids = np.full((len(rows), width), tokenizer.pad, dtype=np.int64)
    mask = np.zeros((len(rows), width), dtype=np.int64)

    for index, row in enumerate(rows):
        ids[index, : len(row)] = row
        mask[index, : len(row)] = 1

    return {
        "input_ids": ids,
        "attention_mask": mask,
        "token_type_ids": np.zeros_like(ids),
    }


def embed(session: ort.InferenceSession, inputs: dict[str, np.ndarray]) -> np.ndarray:
    hidden = session.run(None, inputs)[0]
    cls = hidden[:, 0, :]

    return cls / np.linalg.norm(cls, axis=1, keepdims=True)


def rss_bytes() -> int:
    # ru_maxrss is kilobytes on Linux.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def median_ms(call, runs: int) -> float:
    samples = []

    for _ in range(runs):
        started = time.perf_counter()
        call()
        samples.append((time.perf_counter() - started) * 1000)

    return sorted(samples)[len(samples) // 2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args()

    directory = os.path.join(models_dir(), MODEL_ID)
    options = ort.SessionOptions()
    options.intra_op_num_threads = INTRA_OP_THREADS
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False

    started = time.perf_counter()
    tokenizer = WordPiece(os.path.join(directory, "vocab.txt"))
    session = ort.InferenceSession(
        os.path.join(directory, "onnx", "model.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    load_ms = (time.perf_counter() - started) * 1000

    one = ["the monitor tick pulls the checkout every five minutes"]
    sixteen = [f"{one[0]} ({index})" for index in range(16)]

    cold_started = time.perf_counter()
    first = embed(session, batch(tokenizer, [QUERY_PREFIX + one[0]]))
    cold_ms = (time.perf_counter() - cold_started) * 1000

    warm_one = median_ms(lambda: embed(session, batch(tokenizer, [QUERY_PREFIX + one[0]])), args.runs)
    warm_batch = median_ms(lambda: embed(session, batch(tokenizer, sixteen)), args.runs)

    cat = embed(session, batch(tokenizer, ["the cat sat on the mat"]))[0]
    feline = embed(session, batch(tokenizer, ["a feline rested on a rug"]))[0]
    wal = embed(session, batch(tokenizer, ["sqlite journal mode WAL"]))[0]

    print(
        json.dumps(
            {
                "arm": "python onnxruntime + hand-written WordPiece",
                "onnxruntime": ort.__version__,
                "load_ms": round(load_ms),
                "embed1_cold_ms": round(cold_ms),
                "embed1_warm_ms": round(warm_one),
                "embed16_warm_ms": round(warm_batch),
                "rss_bytes": rss_bytes(),
                "first_dims": [round(float(value), 6) for value in first[0][:4]],
                "cos_paraphrase": round(float(cat @ feline), 4),
                "cos_unrelated": round(float(cat @ wal), 4),
            }
        )
    )


if __name__ == "__main__":
    main()
