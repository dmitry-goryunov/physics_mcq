# Physics MCQ Practice

A Streamlit quiz app built from a 1,022-question physics MCQ bank.

## Features

- Select a physics topic and quiz length.
- Draw questions only from those not recorded as correct.
- Reveal the source solution with a toggle.
- Record only correct answers; incorrect answers remain unanswered.
- Reset progress separately for each topic.
- Download and restore the correct-answer log as CSV.
- Cloud-safe progress: no shared or temporary server-side log file.

## Repository structure

```text
.
├── .streamlit/
│   └── config.toml
├── app.py
├── quiz_core.py
├── questions.json
├── questions.pdf
├── requirements.txt
└── README.md
```

## Run locally

```bash
python -m pip install -r requirements.txt
streamlit run app.py
```

## Deploy on Streamlit Community Cloud

1. Put all files in the root of one GitHub repository.
2. Open `share.streamlit.io` and choose **Create app**.
3. Select the repository and branch.
4. Set the entrypoint to `app.py`.
5. Deploy.

The PDF is about 35 MB. GitHub's website uploader may reject it; use GitHub Desktop or `git push` to add the repository.

## Progress storage

Community Cloud should not be treated as persistent writable file storage. This app therefore encodes completed-question progress in the current URL and provides a CSV download/import backup. Opening the base app URL without its `progress` query parameter starts with an empty record.
