"""Aggiunge allo snapshot SQLite le vendite più recenti (prima pagina dell'archivio, senza browser).

    pip install -r requirements-dev.txt
    python update_db.py

Il sito include nell'HTML solo la prima pagina (~46 auto); le pagine successive si caricano via
JavaScript. Poi ripubblica su Vercel.
Facoltativo: COLLECTINGCARS_COOKIE="<Cookie del tuo account>" per leggere anche i prezzi riservati.
"""
import argparse
import sys
from pathlib import Path

from scrapecar.parser import FetchError, fetch_html, normalize_card, page_url, parse_listing
from scrapecar.storage import Store

parser = argparse.ArgumentParser()
parser.add_argument("--db", type=Path, default=Path(__file__).parent / "data" / "collectingcars.sqlite3")
args = parser.parse_args()

try:
    snap = parse_listing(fetch_html(page_url(1)))
except FetchError as exc:
    sys.exit(str(exc))
if snap["challenge"]:
    sys.exit("Il sito richiede una verifica: aggiornamento interrotto.")
cards = [normalize_card(c, 1) for c in snap["cards"]]
if not cards or len({c["id"] for c in cards}) != len(cards):
    sys.exit("Nessuna auto leggibile o annunci duplicati: struttura del sito cambiata?")
store = Store(args.db)
before = len(store.rows())
store.save_cards(cards)
after = len(store.rows())
print(f"{len(cards)} annunci letti, {after - before} nuovi. Archivio: {after} auto (il sito ne indica {snap['expected'] or 'n/d'}).")
