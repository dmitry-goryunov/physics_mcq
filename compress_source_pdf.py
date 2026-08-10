"""Recompress the high-resolution source PDF into a GitHub-committable
questions.pdf for the live Streamlit app.

physics_mcq_ALL_1022_question_answer_pairs_HQ.pdf (~109 MiB) exceeds
GitHub's 100 MiB file limit. Its embedded page images are near-bilevel
grayscale scans (mostly white background, sharp text/line-art) with far
more antialiasing gray levels than the eye needs at the sizes this app
renders them; quantizing to 16 gray levels and re-deflating cuts image
data by roughly a third with no visible quality loss, while keeping the
same crisp vector-text-plus-raster layout as the HQ source. (The offline
PWA renders its images straight from the uncompressed HQ source instead —
see build_offline_assets.py.)

Rerun this whenever the HQ PDF changes:

    python compress_source_pdf.py
"""

from __future__ import annotations

import io
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

APP_DIR = Path(__file__).resolve().parent
SOURCE_PDF = APP_DIR / "physics_mcq_ALL_1022_question_answer_pairs_HQ.pdf"
OUTPUT_PDF = APP_DIR / "questions.pdf"
GRAY_LEVELS = 16


def quantize(image: Image.Image) -> tuple[bytes, int, int]:
    arr = np.asarray(image.convert("L")).astype(np.float32)
    step = 255.0 / (GRAY_LEVELS - 1)
    levels = np.round(arr / step) * step
    levels = levels.astype(np.uint8)
    height, width = levels.shape
    return levels.tobytes(), width, height


def main() -> None:
    document = fitz.open(SOURCE_PDF)
    for index in range(document.page_count):
        page = document.load_page(index)
        for image_info in page.get_images(full=True):
            xref = image_info[0]
            base = document.extract_image(xref)
            pil_image = Image.open(io.BytesIO(base["image"]))
            samples, width, height = quantize(pil_image)
            pixmap = fitz.Pixmap(fitz.csGRAY, width, height, samples, 0)
            page.replace_image(xref, pixmap=pixmap)
        if (index + 1) % 100 == 0 or index + 1 == document.page_count:
            print(f"Compressed {index + 1}/{document.page_count} pages", flush=True)

    document.save(OUTPUT_PDF, garbage=4, deflate=True, clean=True)
    document.close()
    size_mb = OUTPUT_PDF.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUTPUT_PDF.name}: {size_mb:.1f} MiB")


if __name__ == "__main__":
    main()
