"""Vercel entry point: read-only dashboard API over the bundled SQLite snapshot."""
from __future__ import annotations

import csv
import io
import os
import shutil
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlencode

from flask import Flask, Response, jsonify, request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scrapecar.storage import Store, analyze  # noqa: E402

SOURCE = "https://collectingcars.com/it/sold?refinementList%5BdriveSide%5D=left"
BUNDLED = ROOT / "data" / "collectingcars.sqlite3"
PAGE_SIZE = 50
SORTS = {"sold_date", "price", "title", "year", "brand"}
CSV_FIELDS = ["title", "brand", "model", "body_type", "classification", "year", "sold_date",
              "price", "currency", "price_status", "price_observed_at", "country", "location",
              "drive_side", "url", "fetched_at"]

app = Flask(__name__)


class VercelRoute:
    """Vercel rewrites /api/x to /api/index?route=x; restore the original path for Flask routing."""

    def __init__(self, wsgi):
        self.wsgi = wsgi

    def __call__(self, environ, start_response):
        query = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)
        route = query.pop("route", None)
        if route is not None:
            environ["PATH_INFO"] = "/api/" + route[0].strip("/")
            environ["QUERY_STRING"] = urlencode([(k, v) for k, vs in query.items() for v in vs])
        return self.wsgi(environ, start_response)


app.wsgi_app = VercelRoute(app.wsgi_app)
_lock = threading.Lock()
_state = {}


def database_path():
    """Vercel's deployment is read-only; SQLite needs a writable directory for its journal files."""
    if not os.environ.get("VERCEL"):
        return BUNDLED
    target = Path("/tmp/collectingcars.sqlite3")
    if not target.exists():
        shutil.copyfile(BUNDLED, target)
    return target


def snapshot():
    """Store plus its rows, loaded once per warm instance (the data never changes at runtime)."""
    with _lock:
        if not _state:
            store = Store(database_path())
            _state.update(store=store, rows=store._load(), seed=store.get("seed"), job=store.get("job", {}))
    return _state


def query_args():
    parsed = parse_qs(request.query_string.decode("utf-8", "replace"))
    return {k: (v if k in {"brand", "model"} else v[-1]) for k, v in parsed.items()}


@app.get("/api/status")
def status():
    return jsonify(snapshot()["job"])


@app.get("/api/view")
def view():
    s = snapshot()
    query = query_args()
    every = s["rows"]
    rows = Store._filter(every, query)
    summary = analyze(rows, query.get("dimension", "brand"), query.get("trend_dimension", "brand"))
    sort = query.get("sort", "sold_date")
    if sort not in SORTS:
        sort = "sold_date"
    reverse = query.get("direction", "desc") == "desc"
    present = [r for r in rows if r.get(sort) is not None]
    absent = [r for r in rows if r.get(sort) is None]
    rows = sorted(present, key=lambda r: r[sort], reverse=reverse) + absent
    try:
        page = max(1, int(query.get("page", 1)))
    except (ValueError, TypeError):
        page = 1
    pages = max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, pages)
    page_rows = [{k: v for k, v in r.items() if k != "raw_text"} for r in rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]]
    return jsonify(summary=summary, rows=page_rows, page=page, pages=pages,
                   facets=facets(every, query), job=s["job"], archive_total=len(every), source=SOURCE,
                   no_photo=sum(1 for r in every if not r["image_url"]), seed=s["seed"],
                   updated_at=max((r["fetched_at"] for r in rows), default=None))


def facets(rows, filters):
    # Store.facets() reloads from disk; reuse the in-memory rows instead.
    from collections import defaultdict
    out = {}
    for key in ("brand", "model", "body_type", "currency", "country", "era"):
        counts = defaultdict(int)
        for r in Store._filter(rows, filters, skip=key):
            if r[key] is not None and r[key] != "":
                counts[r[key]] += 1
        selected = filters.get(key, [])
        if isinstance(selected, str):
            selected = [selected] if selected else []
        for value in (selected if key in {"brand", "model"} else selected[:1]):
            counts.setdefault(value, 0)
        out[key] = [dict(value=v, count=c) for v, c in sorted(counts.items(), key=lambda x: str(x[0]).casefold())]
    return out


@app.get("/api/export")
def export():
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, extrasaction="ignore", delimiter=";")
    writer.writeheader()
    for row in Store._filter(snapshot()["rows"], query_args()):
        # Spreadsheet formula injection protection for exported text.
        writer.writerow({k: (format(v, ".2f").replace(".", ",") if isinstance(v, float)
                             else "'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v)
                         for k, v in row.items()})
    return Response(output.getvalue().encode("utf-8-sig"), mimetype="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="collectingcars-vendute.csv"'})


@app.errorhandler(404)
def not_found(_):
    return jsonify(error="Risorsa non trovata"), 404
