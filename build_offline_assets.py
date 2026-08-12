"""Render the offline PWA's static assets: cropped question/solution images
(as WebP, at a higher resolution than the live Streamlit crops) plus a copy
of the question bank and a manifest of every asset the service worker should
be able to cache for offline use.

Images are rendered from SOURCE_PDF, a higher-quality scan than the
questions.pdf used by the live Streamlit app. It's too large for GitHub
(~109 MiB, over the 100 MiB limit) so it's kept local-only (gitignored) and
must be present next to this script to rerun it.

Rerun this whenever SOURCE_PDF or questions.json changes:

    python build_offline_assets.py
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import fitz
from PIL import Image

from quiz_core import BANK, DOCUMENTS, DOCUMENTS_DIR, QUESTIONS, trim_white_space

APP_DIR = Path(__file__).resolve().parent
DOCS_DIR = APP_DIR / "docs"
IMG_DIR = DOCS_DIR / "img"
DOC_IMG_DIR = DOCS_DIR / "doc_img"
DATA_DIR = DOCS_DIR / "data"
SOURCE_PDF = APP_DIR / "physics_mcq_ALL_1022_question_answer_pairs_HQ.pdf"

ZOOM = 4.0
WEBP_QUALITY = 85
WEBP_METHOD = 4

# Reference documents are full text pages, not photographed diagrams, so they
# stay legible at a lower render zoom — keeps the offline cache from doubling.
DOC_ZOOM = 2.0
DOC_WEBP_QUALITY = 82

CORE_ASSETS = [
    "./",
    "index.html",
    "style.css",
    "app.js",
    "manifest.webmanifest",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "data/questions.json",
    "data/documents.json",
]


def render_pair(page: fitz.Page) -> tuple[bytes, bytes]:
    pixmap = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    width, height = image.size
    question = trim_white_space(image.crop((0, 0, int(width * 0.575), height)))
    solution = trim_white_space(image.crop((int(width * 0.605), 0, width, height)))

    q_buf, s_buf = io.BytesIO(), io.BytesIO()
    question.save(q_buf, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    solution.save(s_buf, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return q_buf.getvalue(), s_buf.getvalue()


def build_images() -> list[str]:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    asset_paths: list[str] = []

    with fitz.open(SOURCE_PDF) as document:
        total = document.page_count
        for index in range(total):
            page_number = index + 1
            q_path = IMG_DIR / f"{page_number}_q.webp"
            s_path = IMG_DIR / f"{page_number}_s.webp"
            q_bytes, s_bytes = render_pair(document.load_page(index))
            q_path.write_bytes(q_bytes)
            s_path.write_bytes(s_bytes)
            asset_paths.append(f"img/{page_number}_q.webp")
            asset_paths.append(f"img/{page_number}_s.webp")
            if page_number % 100 == 0 or page_number == total:
                print(f"Rendered {page_number}/{total} pages", flush=True)

    return asset_paths


def build_document_images() -> list[str]:
    """Render every page of each reference document (see quiz_core.DOCUMENTS)
    to WebP for the offline PWA, mirroring build_images() above. Also writes
    docs/data/documents.json so the PWA knows each document's id/title/page
    count without bundling the source PDFs themselves."""
    DOC_IMG_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    asset_paths: list[str] = []
    manifest = []

    for doc in DOCUMENTS:
        with fitz.open(DOCUMENTS_DIR / doc["filename"]) as document:
            total = document.page_count
            for index in range(total):
                page_number = index + 1
                out_path = DOC_IMG_DIR / f"{doc['id']}_{page_number}.webp"
                pixmap = document.load_page(index).get_pixmap(
                    matrix=fitz.Matrix(DOC_ZOOM, DOC_ZOOM), alpha=False
                )
                image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                image.save(
                    out_path, format="WEBP", quality=DOC_WEBP_QUALITY, method=WEBP_METHOD
                )
                asset_paths.append(f"doc_img/{doc['id']}_{page_number}.webp")
                if page_number % 100 == 0 or page_number == total:
                    print(f"  {doc['id']}: rendered {page_number}/{total} pages", flush=True)
        manifest.append({"id": doc["id"], "title": doc["title"], "pages": total})

    (DATA_DIR / "documents.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return asset_paths


def build_question_bank() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    trimmed_questions = [
        {
            "topic": question["topic"],
            "question_number": int(question["question_number"]),
            "page": int(question["page"]),
            "correct_answer": question["correct_answer"],
        }
        for question in QUESTIONS
    ]
    bank_out = {
        "total_questions": BANK["total_questions"],
        "topics": BANK["topics"],
        "questions": trimmed_questions,
    }
    (DATA_DIR / "questions.json").write_text(
        json.dumps(bank_out, ensure_ascii=False), encoding="utf-8"
    )


def build_icons() -> None:
    from PIL import ImageDraw

    icons_dir = DOCS_DIR / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    background = (79, 70, 229, 255)  # indigo
    foreground = (255, 255, 255, 255)

    for size in (192, 512):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        draw.ellipse((0, 0, size, size), fill=background)

        center = size / 2
        nucleus_r = size * 0.07
        orbit_w = size * 0.34
        orbit_h = size * 0.12

        for angle in (0, 60, 120):
            layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            layer_draw = ImageDraw.Draw(layer)
            layer_draw.ellipse(
                (
                    center - orbit_w,
                    center - orbit_h,
                    center + orbit_w,
                    center + orbit_h,
                ),
                outline=foreground,
                width=max(2, int(size * 0.018)),
            )
            layer = layer.rotate(angle, center=(center, center))
            canvas.alpha_composite(layer)

        draw = ImageDraw.Draw(canvas)
        draw.ellipse(
            (
                center - nucleus_r,
                center - nucleus_r,
                center + nucleus_r,
                center + nucleus_r,
            ),
            fill=foreground,
        )
        canvas.save(icons_dir / f"icon-{size}.png", format="PNG")


def build_asset_manifest(image_assets: list[str]) -> None:
    all_assets = sorted(set(CORE_ASSETS) | set(image_assets))
    (DOCS_DIR / "asset-manifest.json").write_text(
        json.dumps(all_assets, ensure_ascii=False), encoding="utf-8"
    )


def main() -> None:
    build_icons()
    build_question_bank()
    image_assets = build_images()
    print("Rendering reference documents...")
    doc_assets = build_document_images()
    build_asset_manifest(image_assets + doc_assets)
    print("Done.")


if __name__ == "__main__":
    main()
