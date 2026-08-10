from __future__ import annotations

import base64
import uuid

import streamlit as st
import streamlit.components.v1 as components
from streamlit_local_storage import LocalStorage

from quiz_core import (
    BANK,
    QUESTION_LOOKUP,
    QUESTIONS_BY_TOPIC,
    TOPIC_NAMES,
    decode_answer_overrides,
    decode_incorrect_counts,
    decode_progress,
    effective_correct_answer,
    encode_answer_overrides,
    encode_incorrect_counts,
    encode_progress,
    progress_from_csv,
    progress_to_csv,
    question_number_bounds,
    render_question_part,
    select_unanswered,
    select_unanswered_range,
    topic_state,
)


st.set_page_config(
    page_title="Physics MCQ Practice",
    page_icon="⚛️",
    layout="wide",
)

st.markdown(
    """
    <style>
    .block-container {padding-top: 1.8rem; padding-bottom: 3rem; max-width: 1400px;}
    [data-testid="stSidebar"] {min-width: 320px; max-width: 320px;}
    .question-meta {color: #5d6673; font-size: 0.92rem; margin-bottom: 0.8rem;}
    .answer-note {color: #5d6673; font-size: 0.9rem;}

    /* --- Smartphone layout (portrait phones and small screens) --- */
    @media (max-width: 640px) {
        .block-container {
            padding-top: 1rem;
            padding-left: 0.8rem;
            padding-right: 0.8rem;
            padding-bottom: 2rem;
        }
        /* Stack every column row vertically so nothing is squeezed side by side */
        [data-testid="stHorizontalBlock"] {
            flex-wrap: wrap !important;
            gap: 0.5rem !important;
        }
        [data-testid="stHorizontalBlock"] > div {
            flex: 1 1 100% !important;
            width: 100% !important;
            min-width: 100% !important;
        }
        /* Let the sidebar overlay use the width it needs without overflowing */
        [data-testid="stSidebar"] {
            min-width: 85vw !important;
            max-width: 92vw !important;
        }
        /* Bigger tap targets for radio options and buttons */
        [data-testid="stRadio"] label {
            padding: 0.15rem 0.4rem;
            font-size: 1.05rem;
        }
        .stButton button {
            min-height: 2.9rem;
            font-size: 1.02rem;
        }
        h1 {font-size: 1.6rem !important;}
        h2 {font-size: 1.25rem !important;}
    }
    </style>
    """,
    unsafe_allow_html=True,
)


PROGRESS_STORAGE_KEY = "physics_mcq_progress_v1"
INCORRECT_STORAGE_KEY = "physics_mcq_incorrect_v1"
OVERRIDES_STORAGE_KEY = "physics_mcq_overrides_v1"

# Bidirectional browser localStorage bridge. Reading happens through the
# Streamlit component return protocol, so it works inside the sandboxed
# component iframe (a plain <script> cannot navigate or reliably reach the
# parent page on Streamlit Community Cloud).
local_storage = LocalStorage()


def read_url_progress() -> set[tuple[str, int]]:
    value = st.query_params.get("progress", "")
    if isinstance(value, list):
        value = value[-1] if value else ""
    return decode_progress(str(value))


def read_url_incorrect() -> dict[str, int]:
    value = st.query_params.get("incorrect", "")
    if isinstance(value, list):
        value = value[-1] if value else ""
    return decode_incorrect_counts(str(value))


def read_url_overrides() -> dict[tuple[str, int], str]:
    value = st.query_params.get("overrides", "")
    if isinstance(value, list):
        value = value[-1] if value else ""
    return decode_answer_overrides(str(value))


def save_progress(completed: set[tuple[str, int]]) -> None:
    token = encode_progress(completed)
    if token:
        st.query_params["progress"] = token
    elif "progress" in st.query_params:
        del st.query_params["progress"]
    st.session_state.completed = set(completed)
    # Mark that progress changed on purpose so the settled run mirrors the new
    # state to browser storage, including clearing it after a reset.
    st.session_state.storage_dirty = True


def save_incorrect(counts: dict[str, int]) -> None:
    trimmed = {topic: count for topic, count in counts.items() if count}
    token = encode_incorrect_counts(trimmed)
    if token:
        st.query_params["incorrect"] = token
    elif "incorrect" in st.query_params:
        del st.query_params["incorrect"]
    st.session_state.incorrect_counts = trimmed
    st.session_state.storage_dirty = True


def save_overrides(overrides: dict[tuple[str, int], str]) -> None:
    token = encode_answer_overrides(overrides)
    if token:
        st.query_params["overrides"] = token
    elif "overrides" in st.query_params:
        del st.query_params["overrides"]
    st.session_state.answer_overrides = dict(overrides)
    st.session_state.storage_dirty = True


def clear_quiz() -> None:
    st.session_state.quiz = []
    st.session_state.quiz_position = 0
    st.session_state.quiz_correct = 0
    st.session_state.submitted = False
    st.session_state.feedback = None
    st.session_state.submitted_was_new = False
    st.session_state.quiz_nonce = uuid.uuid4().hex


def initialise_state() -> None:
    if "completed" not in st.session_state:
        st.session_state.completed = read_url_progress()
        # If the URL already carries real progress, treat storage as resolved.
        st.session_state.ls_restored = bool(st.session_state.completed)
    if "incorrect_counts" not in st.session_state:
        st.session_state.incorrect_counts = read_url_incorrect()
    if "answer_overrides" not in st.session_state:
        st.session_state.answer_overrides = read_url_overrides()
    if "question_zoom" not in st.session_state:
        st.session_state.question_zoom = 1.0
    if "solution_zoom" not in st.session_state:
        st.session_state.solution_zoom = 1.0
    if "quiz" not in st.session_state:
        clear_quiz()
    if "quiz_topic" not in st.session_state:
        st.session_state.quiz_topic = TOPIC_NAMES[0]

    # One-time restore from browser localStorage. On the first run the browser
    # has not responded yet (token is None); it then answers and triggers a
    # rerun, after which the saved token is available and applied.
    if not st.session_state.get("ls_restored"):
        token = local_storage.getItem(PROGRESS_STORAGE_KEY)
        if token:
            restored = decode_progress(str(token))
            if restored:
                st.session_state.completed = restored
                st.query_params["progress"] = str(token)

        incorrect_token = local_storage.getItem(INCORRECT_STORAGE_KEY)
        if incorrect_token:
            restored_incorrect = decode_incorrect_counts(str(incorrect_token))
            if restored_incorrect:
                st.session_state.incorrect_counts = restored_incorrect
                st.query_params["incorrect"] = str(incorrect_token)

        overrides_token = local_storage.getItem(OVERRIDES_STORAGE_KEY)
        if overrides_token:
            restored_overrides = decode_answer_overrides(str(overrides_token))
            if restored_overrides:
                st.session_state.answer_overrides = restored_overrides
                st.query_params["overrides"] = str(overrides_token)

        st.session_state.ls_restored = True


@st.cache_data(show_spinner=False, max_entries=256)
def cached_question_image(page_number: int, part: str) -> bytes:
    return render_question_part(page_number, part)


# The pad key is embedded in the HTML so the component's srcdoc changes (and
# the iframe reloads, clearing the canvas) only when the question changes —
# it survives reruns from selecting an answer, submitting, etc.
_SCRATCH_PAD_HTML = """
<div data-pad-key="__PAD_KEY__" style="border:1px solid #d8dbe3; border-radius:8px; overflow:hidden; font-family:'Segoe UI', system-ui, sans-serif;">
  <div style="display:flex; justify-content:space-between; align-items:center; padding:0.45rem 0.7rem; background:#f2f3f8; border-bottom:1px solid #d8dbe3; font-size:0.85rem; font-weight:600; color:#5d6673;">
    <span>Scratch pad</span>
    <button id="clearBtn" type="button" style="padding:0.3rem 0.7rem; font-size:0.8rem; font-weight:600; border:1px solid #d8dbe3; border-radius:8px; background:#fff; cursor:pointer;">Clear</button>
  </div>
  <canvas id="pad" style="display:block; width:100%; height:420px; touch-action:none; cursor:crosshair; background:#fff;"></canvas>
</div>
<script>
(function () {
  const canvas = document.getElementById("pad");
  const ctx = canvas.getContext("2d");
  const clearBtn = document.getElementById("clearBtn");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1a1a1a";

  let drawing = false;
  let last = null;

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // Some browsers/input drivers reject capture for a given pointer id;
      // drawing still works without it, just less reliable outside bounds.
    }
    last = pos(e);
    ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
    canvas.addEventListener(evt, () => { drawing = false; last = null; })
  );

  clearBtn.addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
})();
</script>
"""


def render_scratch_pad(pad_key: str) -> None:
    components.html(_SCRATCH_PAD_HTML.replace("__PAD_KEY__", pad_key), height=470)


ZOOM_LEVELS = [1.0, 1.5, 2.0, 2.5, 3.0]
BASE_IMAGE_HEIGHT = 300


def render_resizable_image(image_bytes: bytes, alt: str, zoom: float) -> None:
    """An image sized as a multiple of its base box (see ZOOM_LEVELS), in a
    horizontally scrollable strip so zooming past 1x doesn't distort the
    surrounding layout."""
    encoded = base64.b64encode(image_bytes).decode("ascii")
    width_pct = round(zoom * 100)
    height_px = round(BASE_IMAGE_HEIGHT * zoom)
    html = f"""
    <div style="width:100%; overflow-x:auto; overflow-y:hidden; border-radius:8px;">
      <div style="width:{width_pct}%; height:{height_px}px; min-width:160px; min-height:100px;
                  border:1px solid #e2e5ec; border-radius:8px; background:#fff; box-sizing:border-box;">
        <img src="data:image/png;base64,{encoded}" alt="{alt}"
             style="width:100%; height:100%; object-fit:contain; display:block;" />
      </div>
    </div>
    """
    components.html(html, height=height_px + 20, scrolling=True)


initialise_state()
completed: set[tuple[str, int]] = st.session_state.completed
states = topic_state(completed, st.session_state.incorrect_counts)
state_lookup = {row["Topic"]: row for row in states}

with st.sidebar:
    st.header("Quiz setup")
    selected_topic = st.selectbox(
        "Topic",
        TOPIC_NAMES,
        index=TOPIC_NAMES.index(st.session_state.quiz_topic)
        if st.session_state.quiz_topic in TOPIC_NAMES
        else 0,
    )
    selected_state = state_lookup[selected_topic]
    total = selected_state["Total"]
    correct = selected_state["Correct"]
    incorrect = selected_state["Incorrect"]
    unanswered = selected_state["Unanswered"]
    st.progress(correct / total if total else 0)
    st.caption(
        f"{correct} correct; {incorrect} incorrect; {unanswered} unanswered; {total} total"
    )

    show_all = st.checkbox(
        "Show all questions (not just unanswered)",
        key="show_all_questions",
    )
    pool_size = total if show_all else unanswered

    maximum = max(1, pool_size)
    min_number, max_number = question_number_bounds(selected_topic)

    selection_mode = st.radio(
        "Select questions by",
        ["Count", "Question range"],
        horizontal=True,
        disabled=pool_size == 0,
    )

    question_count = min(10, maximum)
    range_from, range_to = min_number, max_number
    range_pool = pool_size

    if selection_mode == "Count":
        question_count = st.number_input(
            "Number of questions",
            min_value=1,
            max_value=maximum,
            value=min(10, maximum),
            step=1,
            disabled=pool_size == 0,
        )
    else:
        range_col1, range_col2 = st.columns(2)
        with range_col1:
            range_from = st.number_input(
                "From question #",
                min_value=min_number,
                max_value=max_number,
                value=min_number,
                step=1,
                disabled=pool_size == 0,
            )
        with range_col2:
            range_to = st.number_input(
                "To question #",
                min_value=min_number,
                max_value=max_number,
                value=max_number,
                step=1,
                disabled=pool_size == 0,
            )
        range_pool = sum(
            1
            for question in QUESTIONS_BY_TOPIC[selected_topic]
            if range_from <= int(question["question_number"]) <= range_to
            and (
                show_all
                or (selected_topic, int(question["question_number"])) not in completed
            )
        )
        range_word = "question(s)" if show_all else "unanswered question(s)"
        st.caption(f"{range_pool} {range_word} in that range.")

    start_disabled = pool_size == 0 or (
        selection_mode == "Question range" and range_pool == 0
    )

    if st.button(
        "Start quiz",
        type="primary",
        use_container_width=True,
        disabled=start_disabled,
    ):
        if selection_mode == "Count":
            selected = select_unanswered(
                selected_topic,
                int(question_count),
                completed,
                include_completed=show_all,
            )
        else:
            selected = select_unanswered_range(
                selected_topic,
                int(range_from),
                int(range_to),
                completed,
                include_completed=show_all,
            )
        st.session_state.quiz = [
            (question["topic"], int(question["question_number"]))
            for question in selected
        ]
        st.session_state.quiz_position = 0
        st.session_state.quiz_correct = 0
        st.session_state.quiz_topic = selected_topic
        st.session_state.submitted = False
        st.session_state.feedback = None
        st.session_state.quiz_nonce = uuid.uuid4().hex
        st.rerun()

    if unanswered == 0:
        st.success("All questions in this topic are recorded as correct.")

    st.divider()
    st.subheader("Topic reset")
    st.caption(
        "Removes recorded correct answers and the incorrect count for the "
        "selected topic."
    )
    confirm_reset = st.checkbox("Confirm reset", key=f"confirm_reset_{selected_topic}")
    if st.button(
        "Reset this topic",
        use_container_width=True,
        disabled=not confirm_reset or (correct == 0 and incorrect == 0),
    ):
        remaining = {key for key in completed if key[0] != selected_topic}
        removed = len(completed) - len(remaining)
        save_progress(remaining)
        remaining_incorrect = {
            topic: count
            for topic, count in st.session_state.incorrect_counts.items()
            if topic != selected_topic
        }
        save_incorrect(remaining_incorrect)
        if st.session_state.quiz_topic == selected_topic:
            clear_quiz()
        st.toast(f"Removed {removed} recorded answer(s) from {selected_topic}.")
        st.rerun()

    st.divider()
    st.subheader("Correct-answer log")
    st.download_button(
        "Download CSV log",
        data=progress_to_csv(completed),
        file_name="correct_answers.csv",
        mime="text/csv",
        use_container_width=True,
    )
    uploaded_log = st.file_uploader(
        "Restore from a CSV log",
        type=["csv"],
        help="Only rows whose answer matches the answer bank are imported.",
    )
    if uploaded_log is not None and st.button(
        "Import log", use_container_width=True
    ):
        imported, rejected = progress_from_csv(uploaded_log.getvalue())
        save_progress(imported)
        clear_quiz()
        message = f"Imported {len(imported)} correct answer(s)."
        if rejected:
            message += f" Rejected {rejected} invalid row(s)."
        st.success(message)
        st.rerun()

    st.caption(
        "Progress is encoded in this app's URL. Keep the current URL or download "
        "the CSV log as a backup. No progress is written to a shared cloud file."
    )

st.title("Physics MCQ Practice")
st.caption(
    "Questions are drawn only from those not yet recorded as correct. "
    "Incorrect attempts are not added to the log."
)

quiz: list[tuple[str, int]] = st.session_state.quiz
position = st.session_state.quiz_position

if quiz and position < len(quiz):
    key = quiz[position]
    question = QUESTION_LOOKUP[key]

    header_left, header_right = st.columns([4, 1])
    with header_left:
        st.subheader(f"{question['topic']} · Question {question['question_number']}")
        st.markdown(
            f"<div class='question-meta'>Question {position + 1} of {len(quiz)}</div>",
            unsafe_allow_html=True,
        )
    with header_right:
        st.metric("Correct this quiz", st.session_state.quiz_correct)

    st.progress((position + 1) / len(quiz))

    question_col, solution_col = st.columns([1.2, 0.8], gap="large")

    with question_col:
        st.select_slider(
            "Zoom",
            options=ZOOM_LEVELS,
            format_func=lambda x: f"{x:g}×",
            key="question_zoom",
        )
        render_resizable_image(
            cached_question_image(int(question["page"]), "question"),
            f"Question {question['question_number']}",
            st.session_state.question_zoom,
        )

        answer_key = (
            f"answer_{st.session_state.quiz_nonce}_{position}_{key[0]}_{key[1]}"
        )
        selected_answer = st.radio(
            "Choose an answer",
            ["A", "B", "C", "D"],
            horizontal=True,
            index=None,
            key=answer_key,
            disabled=st.session_state.submitted,
        )

        submit_col, next_col = st.columns(2)
        with submit_col:
            if st.button(
                "Submit answer",
                type="primary",
                use_container_width=True,
                disabled=selected_answer is None or st.session_state.submitted,
            ):
                effective_answer = effective_correct_answer(
                    question, st.session_state.answer_overrides
                )
                is_correct = selected_answer == effective_answer
                st.session_state.submitted = True
                if is_correct:
                    updated = set(completed)
                    was_new = key not in updated
                    updated.add(key)
                    save_progress(updated)
                    if was_new:
                        st.session_state.quiz_correct += 1
                    st.session_state.submitted_was_new = was_new
                    st.session_state.feedback = (
                        "success",
                        f"Correct. The answer is {effective_answer}.",
                    )
                else:
                    updated_incorrect = dict(st.session_state.incorrect_counts)
                    updated_incorrect[question["topic"]] = (
                        updated_incorrect.get(question["topic"], 0) + 1
                    )
                    save_incorrect(updated_incorrect)
                    st.session_state.submitted_was_new = False
                    st.session_state.feedback = (
                        "error",
                        "Incorrect. This question was not recorded and remains unanswered.",
                    )
                st.rerun()

        with next_col:
            if st.button(
                "Next question" if position + 1 < len(quiz) else "Finish quiz",
                use_container_width=True,
                disabled=not st.session_state.submitted,
            ):
                st.session_state.quiz_position += 1
                st.session_state.submitted = False
                st.session_state.feedback = None
                st.session_state.submitted_was_new = False
                st.rerun()

        feedback = st.session_state.feedback
        if feedback:
            kind, text = feedback
            if kind == "success":
                st.success(text)
            else:
                st.error(text)
                if st.button(
                    f"I'm right — the answer key is wrong (mark {selected_answer} as correct)",
                    key=f"override_{st.session_state.quiz_nonce}_{position}",
                ):
                    updated_overrides = dict(st.session_state.answer_overrides)
                    updated_overrides[key] = selected_answer
                    save_overrides(updated_overrides)

                    updated = set(completed)
                    was_new = key not in updated
                    updated.add(key)
                    save_progress(updated)
                    if was_new:
                        st.session_state.quiz_correct += 1
                    st.session_state.submitted_was_new = was_new
                    st.session_state.feedback = (
                        "success",
                        "Marked as correct. The answer key for this question has "
                        f"been corrected to {selected_answer}.",
                    )
                    st.rerun()

            if st.button(
                "Undo — let me answer again",
                key=f"undo_{st.session_state.quiz_nonce}_{position}",
            ):
                if st.session_state.submitted_was_new:
                    updated = set(completed)
                    updated.discard(key)
                    save_progress(updated)
                    st.session_state.quiz_correct = max(
                        0, st.session_state.quiz_correct - 1
                    )
                st.session_state.submitted = False
                st.session_state.feedback = None
                st.session_state.submitted_was_new = False
                st.rerun()

    with solution_col:
        show_solution = st.toggle(
            "Show solution",
            key=f"solution_{st.session_state.quiz_nonce}_{position}",
        )
        if show_solution:
            st.select_slider(
                "Zoom",
                options=ZOOM_LEVELS,
                format_func=lambda x: f"{x:g}×",
                key="solution_zoom",
            )
            render_resizable_image(
                cached_question_image(int(question["page"]), "solution"),
                f"Solution {question['question_number']}",
                st.session_state.solution_zoom,
            )
        else:
            st.info("Turn on **Show solution** to reveal the source answer page.")

        override_answer = st.session_state.answer_overrides.get(key)
        if override_answer:
            st.caption(
                f"Note: you've corrected this question's answer key to "
                f"**{override_answer}** (overrides the answer shown in the "
                "solution image above)."
            )

        render_scratch_pad(f"{question['topic']}_{question['question_number']}")

elif quiz and position >= len(quiz):
    st.success(
        f"Quiz complete. {st.session_state.quiz_correct} of {len(quiz)} "
        "questions were newly recorded as correct."
    )
    if st.button("Choose another quiz", type="primary"):
        clear_quiz()
        st.rerun()
else:
    st.info("Choose a topic and number of questions in the sidebar, then start a quiz.")

st.divider()
st.subheader("Progress by topic")
st.dataframe(states, hide_index=True, use_container_width=True)

with st.expander("How cloud progress works"):
    st.write(
        "The app does not modify files in GitHub or write one shared CSV on the "
        "Streamlit server. Correct-answer progress, per-topic incorrect counts, "
        "and any answer-key corrections are stored as compact codes in the "
        "current URL and mirrored to this browser's local storage, so they're "
        "restored automatically when you reopen the app on the same device. "
        "Download the CSV log for a portable backup of correct answers, or "
        "import it on another device (incorrect counts and answer-key "
        "corrections aren't included in that backup)."
    )
    st.code(f"Question bank: {BANK['total_questions']} questions", language=None)


# Mirror a deliberate progress change to browser localStorage so the app can
# restore it after being closed and reopened from its base URL. Writing only on
# an actual change (flagged by save_progress) avoids clobbering a saved token
# during the asynchronous restore on load.
if st.session_state.pop("storage_dirty", False):
    _completed_now = st.session_state.completed
    if _completed_now:
        local_storage.setItem(
            PROGRESS_STORAGE_KEY, encode_progress(_completed_now), key="mcq_ls_set"
        )
    elif local_storage.getItem(PROGRESS_STORAGE_KEY):
        local_storage.deleteItem(PROGRESS_STORAGE_KEY, key="mcq_ls_del")

    _incorrect_now = st.session_state.incorrect_counts
    if _incorrect_now:
        local_storage.setItem(
            INCORRECT_STORAGE_KEY,
            encode_incorrect_counts(_incorrect_now),
            key="mcq_ls_set_incorrect",
        )
    elif local_storage.getItem(INCORRECT_STORAGE_KEY):
        local_storage.deleteItem(INCORRECT_STORAGE_KEY, key="mcq_ls_del_incorrect")

    _overrides_now = st.session_state.answer_overrides
    if _overrides_now:
        local_storage.setItem(
            OVERRIDES_STORAGE_KEY,
            encode_answer_overrides(_overrides_now),
            key="mcq_ls_set_overrides",
        )
    elif local_storage.getItem(OVERRIDES_STORAGE_KEY):
        local_storage.deleteItem(OVERRIDES_STORAGE_KEY, key="mcq_ls_del_overrides")
