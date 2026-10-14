# Synthetic Consumer Panel

A browser tool for an EST 440 experiment: **does disclosing that an ad was made with AI change how much consumers trust it?**

It builds a panel of LLM-simulated consumers (personas), shows each one a single version of the same ad (with or without an "AI-generated" label), and compares the two conditions. Every persona is one independent call to the Claude Messages API, and every request and raw answer is kept and inspectable.

> Respondents are simulated, not real consumers. Results show how the model represents these groups and should be checked against a small human sample.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page structure: Setup, Run, Response log, Results |
| `style.css` | Styling (light and dark mode) |
| `app.js` | All logic: panel generation, prompts, API calls, parsing, statistics, charts, export |

No build step and no dependencies.

## Run it

You need a Claude API key from the [Claude Console](https://console.anthropic.com) (API Keys → Create Key) with some credit on the account.

**Locally**

```bash
cd persona-panel
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` by double-click may also work, but a local server is more reliable.

**On GitHub Pages**

1. Create a public repository (for example `persona-panel`) and upload the three files.
2. Settings → Pages → Source: *Deploy from a branch* → Branch: `main` / `(root)` → Save.
3. After a minute the site is live at `https://<your-username>.github.io/persona-panel/`.

The API key is typed into the page by whoever uses it. It is stored only in that browser and sent only to `api.anthropic.com`. **Never put a key in the code or commit it.**

## How to use

1. **Setup**: enter the key, choose the model, then adjust the design: age groups, persona factors and their levels, personas per cell, the ad image, the label drawn on it, an optional caption and the prompt template. The plan line shows the total sample size.
2. Click **Create panel from these settings**.
3. **Run**: start with *Run 1 persona* to see the four steps (persona → API request → raw response → recorded row), then *Run next 10* or *Run all remaining*.
4. **Response log**: click any row to inspect that persona's exact request and raw answer.
5. **Results**: mean ratings by condition and the change in trust by subgroup update as responses arrive.
6. **Save run (JSON)** keeps the whole run (settings, personas, requests, answers). **Load run (JSON)** reopens it later, with no key or internet needed for viewing. **Download CSV** exports the data for R, Python or Excel.

## Method

- **Design**: between-subjects. Each persona sees only one condition. The two ad versions differ only by the disclosure.
- **Stimulus**: an image ad. The uploaded picture is sent to Claude's vision input; the disclosed version has a platform-style label such as "AI-generated" drawn in its top-left corner, and an optional caption is added as text. Images are scaled to at most 1024 px. The saved log replaces image bytes with a short note; the two images are stored once in the run file.
- **Panel**: every combination of age group × factor levels × condition, with *n* personas per cell. Each persona gets an exact age drawn from its group's range. Generation and run order use a fixed random seed, so the same settings always produce the same panel.
- **Background traits**: each persona also gets one randomly drawn option (seeded) from each ticked trait, such as health focus, brand habits and temperament. Traits add realistic person-to-person variation without adding cells, and are saved as columns in the CSV.
- **Blinding**: the prompt never mentions the research question or the other condition.
- **Independence**: each persona is a separate API call with no shared conversation.
- **Measures**: trust in the ad, purchase intent and perceived authenticity on 1–7 scales, plus a one-sentence reason. Answers without three valid 1–7 scores are logged as *not usable* and excluded.
- **Analysis**: disclosed minus not disclosed, Welch's t-test (two-sided) and Cohen's d, overall and within each subgroup, with ~95% confidence intervals (±1.96 SE).

## Limitations

- LLM respondents tend to show less variation than people and can reproduce stereotypes about groups.
- The model may infer what the study is about from the AI label itself.
- Results depend on the model and temperature; record both (they are saved with every run).
- Video ads cannot be sent to the API; use one representative frame.
- Validate the direction of the effect with a small sample of real respondents before drawing conclusions.

## Data dictionary (CSV)

| Column | Meaning |
| --- | --- |
| `id` | Persona id (run order) |
| `age`, `age_group` | Exact age and its group |
| one column per factor | The persona's level of that factor |
| `condition` | `none` (no disclosure) or `disclosed` |
| `status` | `ok`, or `unparsed` if the answer had no valid scores |
| `trust`, `purchase_intent`, `authenticity` | 1–7 ratings |
| `reason` | The persona's one-sentence explanation |
| `model`, `input_tokens`, `output_tokens` | Model that answered and token usage |
| `timestamp` | When the answer was recorded |
| `prompt`, `raw` | The exact prompt sent and the unedited answer |
