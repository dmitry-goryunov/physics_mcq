# Physics MCQ Practice

https://physicsmcq-ipydxtehmwpfsmntfqgljj.streamlit.app/

A Streamlit quiz app built from a 1,022-question physics MCQ bank.

## Features

- Select a physics topic and quiz length.
- Draw questions only from those not recorded as correct.
- Reveal the source solution with a toggle.
- Record only correct answers; incorrect answers remain unanswered.
- Reset progress separately for each topic.
- Download and restore the correct-answer log as CSV.
- Cloud-safe progress: no shared or temporary server-side log file.
- Progress persists in the browser, so closing and reopening the app on the same device restores it automatically.

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

Community Cloud should not be treated as persistent writable file storage. This app therefore encodes completed-question progress in the current URL and also mirrors it to the browser's local storage (via the `streamlit-local-storage` component). When you reopen the app from its base URL on the same device and browser, the saved progress is read back and restored automatically.

Local storage is per-device and per-browser, so it does not follow you to another device or a private/incognito window. For a portable backup, or to move progress between devices, use the **Download CSV log** button and import it elsewhere.
