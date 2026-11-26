from __future__ import annotations

import json
import sqlite3
import statistics
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

FIELDS = ["id","url","title","year","brand","model","variant","body_type","classification",
          "price","currency","price_status","sold_date","country","location","image_url",
          "drive_side","source_page","fetched_at","raw_text"]
PRICE_BANDS = {
    "0-15000": (0, 15000),
    "15000-30000": (15000, 30000),
    "30000-45000": (30000, 45000),
    "45000-60000": (45000, 60000),
    "60000-80000": (60000, 80000),
    "80000-100000": (80000, 100000),
    "100000+": (100000, None),
}


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sales (
                    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, year INTEGER,
                    brand TEXT, model TEXT, variant TEXT, body_type TEXT, classification TEXT,
                    price REAL, currency TEXT, price_status TEXT, sold_date TEXT, country TEXT,
                    location TEXT, image_url TEXT, drive_side TEXT, source_page INTEGER,
                    fetched_at TEXT, raw_text TEXT, price_observed_at TEXT,
                    manual_body_type TEXT, manual_model TEXT
                );
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS pages (
                    run_id TEXT, page INTEGER, fingerprint TEXT, count INTEGER, fetched_at TEXT,
                    PRIMARY KEY(run_id, page)
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, key, default=None):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        with self.connect() as db:
            self._set(db, key, value)

    @staticmethod
    def _set(db, key, value):
        db.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, ensure_ascii=False)))

    def save_cards(self, cards, job=None, fingerprint=None):
        # Preserve a previously observed visible price when a later session is logged out.
        assignments = ",".join(f"{f}=excluded.{f}" for f in FIELDS if f not in ("id","price","currency","price_status","image_url","sold_date","country","location"))
        sql = f"""INSERT INTO sales ({','.join(FIELDS)},price_observed_at)
            VALUES ({','.join('?' for _ in FIELDS)},?) ON CONFLICT(id) DO UPDATE SET {assignments},
            image_url=COALESCE(NULLIF(excluded.image_url,''),sales.image_url),
            sold_date=COALESCE(NULLIF(excluded.sold_date,''),sales.sold_date),
            country=COALESCE(NULLIF(excluded.country,''),sales.country),
            location=COALESCE(NULLIF(excluded.location,''),sales.location),
            price=COALESCE(excluded.price,sales.price), currency=COALESCE(excluded.currency,sales.currency),
            price_status=CASE WHEN excluded.price IS NOT NULL THEN 'visible'
                             WHEN sales.price IS NOT NULL THEN 'previously_visible' ELSE excluded.price_status END,
            price_observed_at=CASE WHEN excluded.price IS NOT NULL THEN excluded.fetched_at ELSE sales.price_observed_at END"""
        with self.connect() as db:
            db.executemany(sql, [[c.get(f) for f in FIELDS] + [c["fetched_at"] if c["price"] is not None else None] for c in cards])
            if job:
                db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)",
                           (job["run_id"],job["current_page"],fingerprint,len(cards),now()))
                self._set(db,"job",job)

    def _load(self):
        with self.connect() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM sales ORDER BY sold_date DESC, title")]
        for r in rows:
            if r["manual_body_type"]:
                r["body_type"] = r["manual_body_type"]
                r["classification"] = "Manuale"
            if r["manual_model"]:
                r["model"] = r["manual_model"]
            r["era"] = f"{r['year']//10*10}" if r["year"] else "Sconosciuta"
        return rows

    @staticmethod
    def _number(value):
        try:
            return float(str(value).replace(",", "."))
        except (TypeError, ValueError):
            return None

    @classmethod
    def _filter(cls, rows, filters, skip=None):
        query = filters.get("q", "").casefold().strip()
        terms = query.split()
        selected_brands = filters.get("brand", [])
        if isinstance(selected_brands, str):
            selected_brands = [selected_brands] if selected_brands else []
        selected_models = filters.get("model", [])
        if isinstance(selected_models, str):
            selected_models = [selected_models] if selected_models else []
        price_min, price_max = cls._number(filters.get("price_min")), cls._number(filters.get("price_max"))
        band_min, band_max = PRICE_BANDS.get(filters.get("price_range"), (None, None))
        year_from, year_to = cls._number(filters.get("year_from")), cls._number(filters.get("year_to"))
        result = []
        for r in rows:
            if terms:
                haystack = " ".join(str(r.get(k) or "") for k in ("title", "brand", "model", "country", "location")).casefold()
                if not all(t in haystack for t in terms):
                    continue
            if skip != "brand" and selected_brands and str(r.get("brand") or "") not in selected_brands:
                continue
            if skip != "model" and selected_models and str(r.get("model") or "") not in selected_models:
                continue
            if any(k not in {"brand", "model", skip} and filters.get(k) and str(r.get(k) or "") != str(filters[k])
                   for k in ("model", "body_type", "currency", "country", "era")):
                continue
            if filters.get("from") and (not r["sold_date"] or r["sold_date"] < filters["from"]):
                continue
            if filters.get("to") and (not r["sold_date"] or r["sold_date"] > filters["to"]):
                continue
            if filters.get("priced") == "1" and r["price"] is None:
                continue
            if filters.get("photo") == "1" and not r["image_url"]:
                continue
            if price_min is not None and (r["price"] is None or r["price"] < price_min):
                continue
            if price_max is not None and (r["price"] is None or r["price"] > price_max):
                continue
            if filters.get("price_range") in PRICE_BANDS and (
                r["price"] is None or r["price"] < band_min or
                (band_max is not None and r["price"] >= band_max)
            ):
                continue
            if year_from is not None and (r["year"] is None or r["year"] < year_from):
                continue
            if year_to is not None and (r["year"] is None or r["year"] > year_to):
                continue
            result.append(r)
        return result

    def rows(self, filters=None):
        return self._filter(self._load(), filters or {})

    def facets(self, filters=None):
        """Options for every select, narrowed by all the *other* active filters, with counts."""
        filters = filters or {}
        rows = self._load()
        out = {}
        for key in ("brand", "model", "body_type", "currency", "country", "era"):
            counts = defaultdict(int)
            for r in self._filter(rows, filters, skip=key):
                if r[key] is not None and r[key] != "":
                    counts[r[key]] += 1
            # Keep the selected value visible even if the other filters exclude it.
            selected = filters.get(key, [])
            if isinstance(selected, str):
                selected = [selected] if selected else []
            selected_values = selected if key in {"brand", "model"} else selected[:1]
            for value in selected_values:
                if value not in counts:
                    counts[value] = 0
            out[key] = [dict(value=v, count=c) for v, c in sorted(counts.items(), key=lambda x: str(x[0]).casefold())]
        return out

    def page_seen(self, run_id, fingerprint):
        with self.connect() as db:
            return db.execute("SELECT page FROM pages WHERE run_id=? AND fingerprint=?",
                              (run_id, fingerprint)).fetchone() is not None


def quantile(values, p):
    if not values:
        return None
    values=sorted(values)
    pos=(len(values)-1)*p
    lo=int(pos)
    return round(values[lo]+(values[min(lo+1,len(values)-1)]-values[lo])*(pos-lo),2)


def price_stats(rows):
    values=[r["price"] for r in rows if r["price"] is not None and r["currency"]]
    return dict(count=len(rows), priced=len(values), missing=len(rows)-len(values),
                mean=round(statistics.mean(values),2) if values else None,
                median=round(statistics.median(values),2) if values else None,
                minimum=min(values) if values else None, maximum=max(values) if values else None,
                q25=quantile(values,.25), q75=quantile(values,.75),
                total=round(sum(values),2) if values else None)


def analyze(rows, dimension="brand", trend_dimension="brand"):
    if dimension not in ("brand","model","body_type","era","country"):
        dimension="brand"
    if trend_dimension not in ("brand","model"):
        trend_dimension="brand"
    by_currency=defaultdict(list)
    grouped=defaultdict(list)
    months=defaultdict(list)
    price_trends=defaultdict(list)
    for r in rows:
        currency=r["currency"] or "N/D"
        by_currency[currency].append(r)
        name=f"{r['brand']} {r['model']}" if dimension == "model" else r.get(dimension, "N/D")
        grouped[(name,currency)].append(r)
        if r["sold_date"] and r["price"] is not None:
            months[(r["sold_date"][:7],currency)].append(r)
            if currency != "N/D":
                brand=r.get("brand") or "Marca sconosciuta"
                model=r.get("model") or "Modello sconosciuto"
                series=brand if trend_dimension == "brand" else f"{brand}\x1f{model}"
                price_trends[(series,brand,model,currency,r["sold_date"][:7])].append(r["price"])
    groups=[dict(name=name,currency=currency,**price_stats(items)) for (name,currency),items in grouped.items()]
    groups.sort(key=lambda x:(-x["count"],x["name"],x["currency"]))
    trend_rows=[
        dict(series=series,name=brand if trend_dimension == "brand" else model,
             brand=brand,model=model,currency=currency,month=month,
             median=round(statistics.median(values),2),count=len(values))
        for (series,brand,model,currency,month),values in sorted(price_trends.items())
    ]
    return dict(count=len(rows), priced=sum(r["price"] is not None for r in rows),
                missing=sum(r["price"] is None for r in rows),
                brands=len({r["brand"] for r in rows}), groups=groups,
                currencies=[dict(currency=c,**price_stats(items)) for c,items in sorted(by_currency.items())],
                trend=[dict(month=m,currency=c,**price_stats(items)) for (m,c),items in sorted(months.items())],
                price_trends=trend_rows)
