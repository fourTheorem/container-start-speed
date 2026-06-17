# Benchmark result visualization

This is a separate Plotly Dash app for exploring benchmark output from
`results/<run-id>/tasks.jsonl`.

Run it with uv and Python 3.14:

```bash
cd visualization
uv run --python 3.14 python app.py
```

Then open <http://127.0.0.1:8050>.

To point at another results directory:

```bash
uv run --python 3.14 python app.py --results /path/to/results
```

The viewer reads raw task records, so it works with complete runs and partially
resumed runs before `summary.csv` has been written.
