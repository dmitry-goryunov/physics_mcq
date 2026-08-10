from __future__ import annotations

import base64
import csv
import io
import json
from functools import lru_cache
from pathlib import Path

import fitz
import numpy as np
from PIL import Image


APP_DIR = Path(__file__).resolve().parent
PDF_PATH = APP_DIR / "questions.pdf"
QUESTIONS_PATH = APP_DIR / "questions.json"
LOG_COLUMNS = ["topic", "question_number", "page", "correct_answer"]


def load_question_bank() -> dict:
    return json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))


BANK = load_question_bank()
QUESTIONS = BANK["questions"]
TOPIC_NAMES = [topic["name"] for topic in BANK["topics"]]
TOPIC_TOTALS = {topic["name"]: int(topic["count"]) for topic in BANK["topics"]}
QUESTIONS_BY_TOPIC = {
    topic: [question for question in QUESTIONS if question["topic"] == topic]
    for topic in TOPIC_NAMES
}
QUESTION_LOOKUP = {
    (question["topic"], int(question["question_number"])): question
    for question in QUESTIONS
}
QUESTION_KEYS = [
    (question["topic"], int(question["question_number"])) for question in QUESTIONS
]
QUESTION_INDEX = {key: index for index, key in enumerate(QUESTION_KEYS)}


def encode_progress(completed: set[tuple[str, int]]) -> str:
    """Encode completed questions as a compact URL-safe bitset."""
    raw = bytearray((len(QUESTION_KEYS) + 7) // 8)
    for key in completed:
        index = QUESTION_INDEX.get(key)
        if index is not None:
            raw[index // 8] |= 1 << (index % 8)
    return base64.urlsafe_b64encode(bytes(raw)).decode("ascii").rstrip("=")


def decode_progress(token: str | None) -> set[tuple[str, int]]:
    if not token:
        return set()
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return set()

    completed: set[tuple[str, int]] = set()
    for index, key in enumerate(QUESTION_KEYS):
        byte_index = index // 8
        if byte_index < len(raw) and raw[byte_index] & (1 << (index % 8)):
            completed.add(key)
    return completed


def encode_incorrect_counts(counts: dict[str, int]) -> str:
    """Encode per-topic incorrect-answer counts as a compact URL-safe token."""
    trimmed = {topic: count for topic, count in counts.items() if count}
    if not trimmed:
        return ""
    raw = json.dumps(trimmed, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_incorrect_counts(token: str | None) -> dict[str, int]:
    if not token:
        return {}
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        topic: count
        for topic, count in data.items()
        if topic in TOPIC_NAMES and isinstance(count, int) and count > 0
    }


def encode_answer_overrides(overrides: dict[tuple[str, int], str]) -> str:
    """Encode per-question answer-key corrections as a compact URL-safe token."""
    trimmed = {
        f"{topic}|{number}": answer
        for (topic, number), answer in overrides.items()
        if answer in {"A", "B", "C", "D"}
    }
    if not trimmed:
        return ""
    raw = json.dumps(trimmed, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_answer_overrides(token: str | None) -> dict[tuple[str, int], str]:
    if not token:
        return {}
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}

    result: dict[tuple[str, int], str] = {}
    for compound_key, answer in data.items():
        if not isinstance(compound_key, str) or "|" not in compound_key:
            continue
        topic, _, number_text = compound_key.rpartition("|")
        if topic not in TOPIC_NAMES or answer not in {"A", "B", "C", "D"}:
            continue
        try:
            number = int(number_text)
        except ValueError:
            continue
        if (topic, number) in QUESTION_INDEX:
            result[(topic, number)] = answer
    return result


def effective_correct_answer(
    question: dict, overrides: dict[tuple[str, int], str]
) -> str:
    """The answer graded as correct, honoring a stored answer-key override."""
    key = (question["topic"], int(question["question_number"]))
    return overrides.get(key, question["correct_answer"])


def topic_state(
    completed: set[tuple[str, int]],
    incorrect_counts: dict[str, int] | None = None,
) -> list[dict]:
    incorrect_counts = incorrect_counts or {}
    state = []
    for topic in TOPIC_NAMES:
        total = TOPIC_TOTALS[topic]
        correct = sum(
            (topic, int(question["question_number"])) in completed
            for question in QUESTIONS_BY_TOPIC[topic]
        )
        state.append(
            {
                "Topic": topic,
                "Correct": correct,
                "Incorrect": incorrect_counts.get(topic, 0),
                "Unanswered": total - correct,
                "Total": total,
            }
        )
    return state


def select_unanswered(
    topic: str, count: int, completed: set[tuple[str, int]]
) -> list[dict]:
    if topic not in QUESTIONS_BY_TOPIC:
        raise KeyError(topic)
    unanswered = [
        question
        for question in QUESTIONS_BY_TOPIC[topic]
        if (topic, int(question["question_number"])) not in completed
    ]
    unanswered.sort(key=lambda question: int(question["question_number"]))
    number = min(max(0, int(count)), len(unanswered))
    return unanswered[:number]


def question_number_bounds(topic: str) -> tuple[int, int]:
    if topic not in QUESTIONS_BY_TOPIC or not QUESTIONS_BY_TOPIC[topic]:
        raise KeyError(topic)
    numbers = [int(question["question_number"]) for question in QUESTIONS_BY_TOPIC[topic]]
    return min(numbers), max(numbers)


def select_unanswered_range(
    topic: str, start: int, end: int, completed: set[tuple[str, int]]
) -> list[dict]:
    """Return every unanswered question in [start, end] (inclusive), in order."""
    if topic not in QUESTIONS_BY_TOPIC:
        raise KeyError(topic)
    low, high = min(int(start), int(end)), max(int(start), int(end))
    unanswered = [
        question
        for question in QUESTIONS_BY_TOPIC[topic]
        if low <= int(question["question_number"]) <= high
        and (topic, int(question["question_number"])) not in completed
    ]
    unanswered.sort(key=lambda question: int(question["question_number"]))
    return unanswered


def progress_to_csv(completed: set[tuple[str, int]]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=LOG_COLUMNS)
    writer.writeheader()
    for question in QUESTIONS:
        key = (question["topic"], int(question["question_number"]))
        if key in completed:
            writer.writerow(
                {
                    "topic": question["topic"],
                    "question_number": question["question_number"],
                    "page": question["page"],
                    "correct_answer": question["correct_answer"],
                }
            )
    return output.getvalue().encode("utf-8")


def progress_from_csv(data: bytes) -> tuple[set[tuple[str, int]], int]:
    """Import only rows whose answer matches the bank's correct answer."""
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    completed: set[tuple[str, int]] = set()
    rejected = 0
    for row in reader:
        try:
            topic = str(row.get("topic", "")).strip()
            number = int(str(row.get("question_number", "")).strip())
            supplied_answer = str(row.get("correct_answer", "")).strip().upper()
        except (TypeError, ValueError):
            rejected += 1
            continue

        question = QUESTION_LOOKUP.get((topic, number))
        if question is None or supplied_answer != question["correct_answer"]:
            rejected += 1
            continue
        completed.add((topic, number))
    return completed, rejected


def trim_white_space(image: Image.Image, margin: int = 24) -> Image.Image:
    """Trim white margins and ignore long divider lines from the source scan."""
    rgb = image.convert("RGB")
    width, height = rgb.size

    working_height = max(1, int(height * 0.94))
    working = rgb.crop((0, 0, width, working_height))
    pixels = np.asarray(working)
    dark = pixels.min(axis=2) < 245

    line_columns = np.where(dark.mean(axis=0) > 0.45)[0]
    for column in line_columns:
        dark[:, max(0, column - 2) : min(width, column + 3)] = False

    row_threshold = max(3, int(width * 0.003))
    content_rows = np.where(dark.sum(axis=1) > row_threshold)[0]
    if content_rows.size == 0:
        return working

    top_row = int(content_rows[0])
    bottom_row = int(content_rows[-1])
    content_columns = np.where(dark[top_row : bottom_row + 1].sum(axis=0) > 1)[0]
    if content_columns.size == 0:
        return working

    left = max(0, int(content_columns[0]) - margin)
    top = max(0, top_row - margin)
    right = min(width, int(content_columns[-1]) + margin + 1)
    bottom = min(working_height, bottom_row + margin + 1)
    return working.crop((left, top, right, bottom))


@lru_cache(maxsize=256)
def render_question_part(page_number: int, part: str) -> bytes:
    if part not in {"question", "solution"}:
        raise ValueError("part must be 'question' or 'solution'")
    if not 1 <= page_number <= int(BANK["total_questions"]):
        raise ValueError("page number outside question bank")

    with fitz.open(PDF_PATH) as document:
        page = document.load_page(page_number - 1)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)

    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    width, height = image.size
    if part == "question":
        cropped = image.crop((0, 0, int(width * 0.575), height))
    else:
        cropped = image.crop((int(width * 0.605), 0, width, height))

    cropped = trim_white_space(cropped)
    output = io.BytesIO()
    cropped.save(output, format="PNG", optimize=True)
    return output.getvalue()
