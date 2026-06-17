from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.express as px
from dash import Dash, Input, Output, dash_table, dcc, html


METRICS = {
    "createdToStarted": "Overall start: created to started",
    "createdToPullStart": "Created to image pull start",
    "imagePull": "Image pull",
    "pullStopToStarted": "Image pulled to task started",
    "createdToStopped": "Created to stopped",
    "startedToStopped": "Workload runtime",
    "ec2LaunchToEcsRegistered": "EC2 launch to ECS registered",
    "ec2LaunchToTaskCreated": "EC2 launch to task created",
    "ecsRegisteredToTaskCreated": "ECS registered to task created",
}

PHASE_METRICS = ["createdToPullStart", "imagePull", "pullStopToStarted"]
EC2_METRICS = ["ec2LaunchToEcsRegistered", "ecsRegisteredToTaskCreated"]
GROUP_COLUMNS = ["target", "cpuArchitecture", "imageSize", "compression", "sociMode"]
FILTER_COLUMNS = {
    "targets": "target",
    "architectures": "cpuArchitecture",
    "sizes": "imageSize",
    "compressions": "compression",
    "sociModes": "sociMode",
}
STATUS_OPTIONS = [
    {"label": "Successful benchmark tasks", "value": "successful"},
    {"label": "Failed/incomplete diagnostics", "value": "failed"},
]


@dataclass(frozen=True)
class RunInfo:
    value: str
    label: str
    path: Path
    started_at: str
    task_records: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dash viewer for ECS container start benchmark results.")
    parser.add_argument(
        "--results",
        default=str(Path(__file__).resolve().parents[1] / "results"),
        help="Directory containing benchmark run subdirectories.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8050)
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args()


def discover_runs(results_dir: Path) -> list[RunInfo]:
    if not results_dir.exists():
        return []

    runs: list[RunInfo] = []
    for path in sorted(results_dir.iterdir(), key=lambda candidate: candidate.stat().st_mtime, reverse=True):
        if not path.is_dir():
            continue
        tasks_path = path / "tasks.jsonl"
        run_path = path / "run.json"
        if not tasks_path.exists() and not run_path.exists():
            continue

        metadata = read_json(run_path)
        task_records = int(metadata.get("taskRecords") or count_jsonl(tasks_path))
        run_id = str(metadata.get("runId") or path.name)
        started_at = str(metadata.get("startedAt") or "")
        label_date = started_at or path.name
        label = f"{label_date} · {task_records} tasks"
        runs.append(RunInfo(value=path.name, label=label, path=path, started_at=started_at, task_records=task_records))
    return runs


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def count_jsonl(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def load_run(path: Path) -> pd.DataFrame:
    records = []
    tasks_path = path / "tasks.jsonl"
    if not tasks_path.exists():
        return empty_frame()

    with tasks_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Could not parse {tasks_path}:{line_number}: {exc}") from exc
            records.append(flatten_record(record))

    if not records:
        return empty_frame()

    frame = pd.DataFrame.from_records(records)
    for column in GROUP_COLUMNS:
        if column not in frame:
            frame[column] = ""
    for metric in METRICS:
        if metric not in frame:
            frame[metric] = pd.NA
        frame[metric] = pd.to_numeric(frame[metric], errors="coerce")
        frame[f"{metric}Seconds"] = frame[metric] / 1000
    frame["containerExitCode"] = pd.to_numeric(frame.get("containerExitCode"), errors="coerce")
    frame["benchmarkStatus"] = frame.apply(benchmark_status, axis=1)
    frame["configuration"] = frame.apply(configuration_label, axis=1)
    return frame


def empty_frame() -> pd.DataFrame:
    columns = [
        *GROUP_COLUMNS,
        "configuration",
        "benchmarkStatus",
        *METRICS.keys(),
        *[f"{metric}Seconds" for metric in METRICS],
    ]
    return pd.DataFrame(columns=columns)


def flatten_record(record: dict[str, Any]) -> dict[str, Any]:
    durations = record.get("durationsMs") or {}
    flattened = {key: value for key, value in record.items() if key != "durationsMs"}
    for metric in METRICS:
        flattened[metric] = durations.get(metric)
    return flattened


def configuration_label(row: pd.Series) -> str:
    return " / ".join(str(row[column]) for column in GROUP_COLUMNS)


def benchmark_status(row: pd.Series) -> str:
    if row.get("containerExitCode") == 0 and pd.notna(row.get("createdToStarted")):
        return "successful"
    return "failed"


def options_for(frame: pd.DataFrame, column: str) -> list[dict[str, str]]:
    values = sorted(value for value in frame[column].dropna().astype(str).unique() if value)
    return [{"label": value, "value": value} for value in values]


def selected_or_all(selected: list[str] | None, options: list[dict[str, str]]) -> list[str]:
    return selected or [option["value"] for option in options]


def apply_filters(
    frame: pd.DataFrame,
    targets: list[str] | None,
    architectures: list[str] | None,
    sizes: list[str] | None,
    compressions: list[str] | None,
    soci_modes: list[str] | None,
    statuses: list[str] | None,
) -> pd.DataFrame:
    filtered = frame.copy()
    selections = {
        "target": targets,
        "cpuArchitecture": architectures,
        "imageSize": sizes,
        "compression": compressions,
        "sociMode": soci_modes,
    }
    for column, values in selections.items():
        if values:
            filtered = filtered[filtered[column].isin(values)]
    if statuses:
        filtered = filtered[filtered["benchmarkStatus"].isin(statuses)]
    return filtered


def describe(values: pd.Series) -> pd.Series:
    samples = values.dropna().sort_values()
    if samples.empty:
        return pd.Series({"n": 0, "mean": None, "p50": None, "p90": None, "p95": None, "min": None, "max": None})
    return pd.Series(
        {
            "n": int(samples.count()),
            "mean": round(float(samples.mean()), 3),
            "p50": round(float(samples.quantile(0.50)), 3),
            "p90": round(float(samples.quantile(0.90)), 3),
            "p95": round(float(samples.quantile(0.95)), 3),
            "min": round(float(samples.min()), 3),
            "max": round(float(samples.max()), 3),
        }
    )


def summary_table(frame: pd.DataFrame, metric: str) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    stats = (
        frame.groupby(GROUP_COLUMNS, dropna=False)[f"{metric}Seconds"]
        .apply(describe)
        .unstack()
        .reset_index()
        .sort_values(["target", "cpuArchitecture", "imageSize", "compression", "sociMode"])
    )
    return stats.to_dict("records")


def empty_figure(title: str):
    figure = px.scatter(title=title)
    figure.update_layout(
        annotations=[
            {
                "text": "No data for the current selection",
                "xref": "paper",
                "yref": "paper",
                "x": 0.5,
                "y": 0.5,
                "showarrow": False,
            }
        ],
        xaxis={"visible": False},
        yaxis={"visible": False},
    )
    return figure


def metric_distribution(frame: pd.DataFrame, metric: str):
    column = f"{metric}Seconds"
    visible = frame.dropna(subset=[column])
    if visible.empty:
        return empty_figure(METRICS[metric])
    figure = px.box(
        visible,
        x="configuration",
        y=column,
        color="target",
        points="all",
        title=METRICS[metric],
        labels={"configuration": "Configuration", column: "Seconds", "target": "Target"},
    )
    figure.update_layout(xaxis_tickangle=-35, margin={"l": 40, "r": 24, "t": 56, "b": 160})
    return figure


def phase_breakdown(frame: pd.DataFrame, statistic: str):
    available = [metric for metric in PHASE_METRICS if frame[metric].notna().any()]
    if frame.empty or not available:
        return empty_figure("Start phase breakdown")

    rows = []
    for group_values, group in frame.groupby(GROUP_COLUMNS, dropna=False):
        config = " / ".join(str(value) for value in group_values)
        for metric in available:
            samples = group[f"{metric}Seconds"].dropna()
            if samples.empty:
                continue
            value = float(samples.quantile(float(statistic[1:]) / 100)) if statistic.startswith("p") else float(samples.mean())
            rows.append({"configuration": config, "phase": METRICS[metric], "seconds": round(value, 3)})

    if not rows:
        return empty_figure("Start phase breakdown")

    figure = px.bar(
        pd.DataFrame(rows),
        x="configuration",
        y="seconds",
        color="phase",
        title=f"Start phase breakdown ({statistic})",
        labels={"configuration": "Configuration", "seconds": "Seconds", "phase": "Phase"},
    )
    figure.update_layout(barmode="stack", xaxis_tickangle=-35, margin={"l": 40, "r": 24, "t": 56, "b": 160})
    return figure


def ec2_breakdown(frame: pd.DataFrame, statistic: str):
    ec2_frame = frame[frame["target"].astype(str).str.startswith("ec2")]
    available = [metric for metric in EC2_METRICS if metric in ec2_frame and ec2_frame[metric].notna().any()]
    if ec2_frame.empty or not available:
        return empty_figure("EC2 host timing")

    rows = []
    for group_values, group in ec2_frame.groupby(GROUP_COLUMNS, dropna=False):
        config = " / ".join(str(value) for value in group_values)
        for metric in available:
            samples = group[f"{metric}Seconds"].dropna()
            if samples.empty:
                continue
            value = float(samples.quantile(float(statistic[1:]) / 100)) if statistic.startswith("p") else float(samples.mean())
            rows.append({"configuration": config, "phase": METRICS[metric], "seconds": round(value, 3)})

    if not rows:
        return empty_figure("EC2 host timing")

    figure = px.bar(
        pd.DataFrame(rows),
        x="configuration",
        y="seconds",
        color="phase",
        title=f"EC2 host timing ({statistic})",
        labels={"configuration": "Configuration", "seconds": "Seconds", "phase": "Phase"},
    )
    figure.update_layout(barmode="group", xaxis_tickangle=-35, margin={"l": 40, "r": 24, "t": 56, "b": 160})
    return figure


def make_app(results_dir: Path) -> Dash:
    runs = discover_runs(results_dir)
    initial_run = runs[0].value if runs else None
    app = Dash(__name__, title="ECS Start Benchmark")

    app.layout = html.Div(
        className="page",
        children=[
            html.Div(
                className="header",
                children=[
                    html.H1("ECS Container Start Benchmark"),
                    html.Div(str(results_dir), className="results-path"),
                ],
            ),
            html.Div(
                className="controls",
                children=[
                    html.Label("Run", htmlFor="run-select"),
                    dcc.Dropdown(
                        id="run-select",
                        options=[{"label": run.label, "value": run.value} for run in runs],
                        value=initial_run,
                        clearable=False,
                    ),
                    html.Label("Metric", htmlFor="metric-select"),
                    dcc.Dropdown(
                        id="metric-select",
                        options=[{"label": label, "value": metric} for metric, label in METRICS.items()],
                        value="createdToStarted",
                        clearable=False,
                    ),
                    html.Label("Breakdown statistic", htmlFor="statistic-select"),
                    dcc.Dropdown(
                        id="statistic-select",
                        options=[
                            {"label": "p50", "value": "p50"},
                            {"label": "p90", "value": "p90"},
                            {"label": "p95", "value": "p95"},
                            {"label": "mean", "value": "mean"},
                        ],
                        value="p50",
                        clearable=False,
                    ),
                    html.Label("Task status", htmlFor="status-filter"),
                    dcc.Checklist(
                        id="status-filter",
                        options=STATUS_OPTIONS,
                        value=["successful"],
                        inputStyle={"marginRight": "6px"},
                        labelStyle={"display": "block", "fontSize": "13px", "lineHeight": "1.7"},
                    ),
                    html.Label("Target", htmlFor="target-filter"),
                    dcc.Dropdown(id="target-filter", multi=True),
                    html.Label("Architecture", htmlFor="arch-filter"),
                    dcc.Dropdown(id="arch-filter", multi=True),
                    html.Label("Image size", htmlFor="size-filter"),
                    dcc.Dropdown(id="size-filter", multi=True),
                    html.Label("Compression", htmlFor="compression-filter"),
                    dcc.Dropdown(id="compression-filter", multi=True),
                    html.Label("SOCI", htmlFor="soci-filter"),
                    dcc.Dropdown(id="soci-filter", multi=True),
                ],
            ),
            html.Div(id="run-summary", className="summary"),
            dcc.Graph(id="metric-distribution"),
            dcc.Graph(id="phase-breakdown"),
            dcc.Graph(id="ec2-breakdown"),
            html.H2("Summary"),
            dash_table.DataTable(
                id="summary-table",
                columns=[
                    {"name": "target", "id": "target"},
                    {"name": "arch", "id": "cpuArchitecture"},
                    {"name": "size", "id": "imageSize"},
                    {"name": "compression", "id": "compression"},
                    {"name": "soci", "id": "sociMode"},
                    {"name": "n", "id": "n"},
                    {"name": "mean", "id": "mean"},
                    {"name": "p50", "id": "p50"},
                    {"name": "p90", "id": "p90"},
                    {"name": "p95", "id": "p95"},
                    {"name": "min", "id": "min"},
                    {"name": "max", "id": "max"},
                ],
                page_size=20,
                sort_action="native",
                filter_action="native",
                style_table={"overflowX": "auto"},
                style_cell={"fontFamily": "system-ui", "fontSize": 13, "padding": "8px", "textAlign": "left"},
                style_header={"fontWeight": "700", "backgroundColor": "#eef2f6"},
            ),
        ],
    )

    @app.callback(
        Output("target-filter", "options"),
        Output("target-filter", "value"),
        Output("arch-filter", "options"),
        Output("arch-filter", "value"),
        Output("size-filter", "options"),
        Output("size-filter", "value"),
        Output("compression-filter", "options"),
        Output("compression-filter", "value"),
        Output("soci-filter", "options"),
        Output("soci-filter", "value"),
        Input("run-select", "value"),
    )
    def update_filter_options(run_value: str | None):
        frame = load_selected_run(results_dir, run_value)
        outputs: list[Any] = []
        for control_id, column in FILTER_COLUMNS.items():
            options = options_for(frame, column)
            outputs.extend([options, selected_or_all(None, options)])
        return outputs

    @app.callback(
        Output("run-summary", "children"),
        Output("metric-distribution", "figure"),
        Output("phase-breakdown", "figure"),
        Output("ec2-breakdown", "figure"),
        Output("summary-table", "data"),
        Input("run-select", "value"),
        Input("metric-select", "value"),
        Input("statistic-select", "value"),
        Input("target-filter", "value"),
        Input("arch-filter", "value"),
        Input("size-filter", "value"),
        Input("compression-filter", "value"),
        Input("soci-filter", "value"),
        Input("status-filter", "value"),
    )
    def update_view(
        run_value: str | None,
        metric: str,
        statistic: str,
        targets: list[str] | None,
        architectures: list[str] | None,
        sizes: list[str] | None,
        compressions: list[str] | None,
        soci_modes: list[str] | None,
        statuses: list[str] | None,
    ):
        frame = load_selected_run(results_dir, run_value)
        filtered = apply_filters(frame, targets, architectures, sizes, compressions, soci_modes, statuses)
        selected_without_status = apply_filters(frame, targets, architectures, sizes, compressions, soci_modes, None)
        failed_count = int((selected_without_status["benchmarkStatus"] == "failed").sum()) if not selected_without_status.empty else 0
        summary = html.Div(
            [
                html.Span(f"{len(filtered)} selected tasks"),
                html.Span(f"{filtered['configuration'].nunique() if not filtered.empty else 0} configurations"),
                html.Span(f"{failed_count} failed/incomplete tasks in filtered run"),
                html.Span(f"{run_value or 'no run selected'}"),
            ],
            className="summary-items",
        )
        return (
            summary,
            metric_distribution(filtered, metric),
            phase_breakdown(filtered, statistic),
            ec2_breakdown(filtered, statistic),
            summary_table(filtered, metric),
        )

    app.index_string = INDEX_TEMPLATE
    return app


def load_selected_run(results_dir: Path, run_value: str | None) -> pd.DataFrame:
    if not run_value:
        return empty_frame()
    run_path = results_dir / run_value
    if not run_path.exists():
        return empty_frame()
    return load_run(run_path)


INDEX_TEMPLATE = """
<!DOCTYPE html>
<html>
  <head>
    {%metas%}
    <title>{%title%}</title>
    {%favicon%}
    {%css%}
    <style>
      body {
        margin: 0;
        background: #f5f7fa;
        color: #16202a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .page {
        max-width: 1480px;
        margin: 0 auto;
        padding: 28px 32px 48px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: flex-end;
        margin-bottom: 22px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.2;
      }
      h2 {
        margin-top: 26px;
        font-size: 18px;
      }
      .results-path {
        color: #5b6978;
        font-size: 13px;
        word-break: break-all;
      }
      .controls {
        display: grid;
        grid-template-columns: repeat(6, minmax(150px, 1fr));
        gap: 10px 14px;
        align-items: end;
        margin-bottom: 18px;
      }
      .controls label {
        font-size: 12px;
        font-weight: 700;
        color: #4e5c6b;
        margin-bottom: -4px;
      }
      .summary {
        min-height: 38px;
      }
      .summary-items {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 8px 0 18px;
      }
      .summary-items span {
        background: #e9eef5;
        border: 1px solid #d7dee8;
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 13px;
      }
      .dash-graph {
        background: white;
        border: 1px solid #dfe5ec;
        border-radius: 8px;
        margin-bottom: 16px;
      }
      @media (max-width: 980px) {
        .page {
          padding: 18px;
        }
        .header {
          display: block;
        }
        .controls {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    {%app_entry%}
    <footer>
      {%config%}
      {%scripts%}
      {%renderer%}
    </footer>
  </body>
</html>
"""


if __name__ == "__main__":
    cli_args = parse_args()
    dash_app = make_app(Path(cli_args.results).expanduser().resolve())
    dash_app.run(host=cli_args.host, port=cli_args.port, debug=cli_args.debug)
