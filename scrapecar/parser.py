"""Fetch the server-rendered sold archive and normalize only prices actually shown on a card."""
from __future__ import annotations

import gzip
import hashlib
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

from bs4 import BeautifulSoup

SOURCE = "https://collectingcars.com/it/sold?refinementList%5BdriveSide%5D=left"
BRANDS = sorted([
    "Alfa Romeo", "Aston Martin", "Austin Healey", "Austin-Healey", "BMW Alpina",
    "De Tomaso", "Land Rover", "Mercedes-Benz", "Mercedes-AMG", "Rolls-Royce",
    "AC", "Abarth", "Alpina", "Alpine", "Ariel", "Audi", "Austin", "Bentley",
    "BMW", "Bristol", "Bugatti", "Buick", "Cadillac", "Caterham", "Chevrolet",
    "Chrysler", "Citroen", "Citroën", "Dacia", "Datsun", "Dodge", "Donkervoort",
    "Ferrari", "Fiat", "Ford", "Ginetta", "GMC", "Holden", "Honda", "Hummer",
    "Hyundai", "INEOS", "Isuzu", "Jaguar", "Jeep", "Jensen", "Kia", "KTM",
    "Lada", "Lamborghini", "Lancia", "Lexus", "Lincoln", "Lister", "Lotus",
    "Marcos", "Maserati", "Mazda", "McLaren", "MG", "Mini", "Mitsubishi",
    "Morgan", "Morris", "Nissan", "Noble", "Opel", "Pagani", "Peugeot",
    "Plymouth", "Pontiac", "Porsche", "Radical", "Renault", "Riley", "Rover",
    "RUF", "Saab", "Seat", "Shelby", "Skoda", "Smart", "Subaru", "Sunbeam",
    "Suzuki", "Tesla", "Toyota", "Triumph", "TVR", "Vauxhall", "Volkswagen",
    "Volvo", "Westfield", "Wiesmann", "Willys", "Zenos",
], key=len, reverse=True)
CURRENCIES = {"€":"EUR", "£":"GBP", "US$":"USD", "AU$":"AUD", "A$":"AUD",
              "HK$":"HKD", "S$":"SGD", "SG$":"SGD", "C$":"CAD", "CA$":"CAD",
              "NZ$":"NZD", **{x:x for x in ["EUR","GBP","USD","AUD","CAD","CHF",
              "HKD","SGD","NZD","SEK","NOK","DKK","AED","JPY","ZAR"]}}
_currency = "|".join(re.escape(x) for x in sorted(CURRENCIES, key=len, reverse=True))
_number = r"\d[\d.,\s\u00a0\u202f'’]*"
PRICE = re.compile(rf"^(?:({_currency})\s*({_number})|({_number})\s*({_currency}))$", re.I)
LOCKED = re.compile(r"accedi per visualizzare|log\s?in to (?:view|see)|sign in to (?:view|see)", re.I)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_price(text):
    text = text.strip().replace("\u00a0", " ").replace("\u202f", " ")
    match = PRICE.fullmatch(text)
    if not match:
        return None, None
    code, amount = (match[1], match[2]) if match[1] else (match[4], match[3])
    code = next((v for k,v in CURRENCIES.items() if k.casefold() == code.casefold()), None)
    number = re.sub(r"[\s'’]", "", amount)
    if "," in number and "." in number:
        decimal = "," if number.rfind(",") > number.rfind(".") else "."
        number = number.replace("." if decimal == "," else ",", "").replace(decimal, ".")
    elif "," in number or "." in number:
        separator = "," if "," in number else "."
        pieces = number.split(separator)
        if len(pieces) > 1 and all(len(x) == 3 for x in pieces[1:]):
            number = "".join(pieces)
        elif len(pieces) == 2 and len(pieces[1]) in (1, 2):
            number = ".".join(pieces)
        else:
            return None, None
    try:
        value = float(number)
    except ValueError:
        return None, None
    return (value, code) if 0 < value < 1e12 else (None, None)


def classify(title):
    t = title.casefold()
    rules = [
        (r"\b(challenge|race car|racecar|cup car|rally car|gt3 cup|competition car)\b", "Da competizione"),
        (r"\b(cabriolet|convertible|roadster|spider|spyder|targa|cabrio|cielo|volante|barchetta)\b", "Cabriolet / Roadster"),
        (r"\b(estate|avant|sportwagon|cross turismo|shooting brake)\b|\b(?:bmw|alpina)\b.*\btouring\b", "Station wagon"),
        (r"\b(defender|discovery|range rover|land cruiser|cherokee|wrangler|cayenne|macan|g500|g320|500 ge|jimny|bronco|urus|g63|g 63)\b", "SUV / Fuoristrada"),
        (r"\b(saloon|sedan|berlina|quattroporte)\b", "Berlina"),
        (r"\b(hatchback|megane|clio|golf|integrale|205|106|208|civic)\b", "Berlina compatta"),
        (r"\b(coupe|coupé|berlinetta|911|corvette|gt3|gt2|gallardo|huracan|f430|vanquish|camaro|mustang|mc20|urraco)\b", "Coupé"),
    ]
    return next((label for pattern,label in rules if re.search(pattern,t)), "Non classificata")


def parse_identity(title):
    year_match = re.match(r"^((?:18|19|20)\d{2})\s+", title)
    year = int(year_match[1]) if year_match else None
    rest = title[year_match.end():] if year_match else title
    brand = next((b for b in BRANDS if re.match(re.escape(b) + r"(?:\s|$)", rest, re.I)), None)
    if not brand:
        return year, "Non riconosciuta", rest, rest
    rest = rest[len(brand):].strip()
    clean = re.sub(r"^\([^)]+\)\s*", "", rest)
    families = ["Continental GT", "Continental GTC", "Land Cruiser", "Range Rover",
                "Grand Cherokee", "Silver Shadow", "Silver Spirit", "Grand Wagoneer"]
    model = next((m for m in families if clean.casefold().startswith(m.casefold())), None)
    model = model or (clean.split()[0] if clean else "Non specificato")
    if brand in ("Mercedes-AMG", "Mercedes-Benz"):
        brand = "Mercedes-Benz"
    if brand == "Citroen":
        brand = "Citroën"
    return year, brand, model, rest


def normalize_card(card, page=1, fetched_at=None):
    parsed = urlparse(card.get("url", ""))
    if parsed.hostname not in ("collectingcars.com", "www.collectingcars.com"):
        raise ValueError("Annuncio con dominio non valido")
    match = re.search(r"/for-sale/([^/?#]+)/?$", parsed.path)
    if not match:
        raise ValueError("URL annuncio non valido")
    title = re.sub(r"\s+", " ", card.get("title", "")).strip()
    if not title:
        raise ValueError("Titolo annuncio mancante")
    text = card.get("text", "")
    locked = bool(LOCKED.search(text))
    price, currency = None, None
    # A login marker always wins over any value accidentally present in the DOM.
    if not locked:
        for line in card.get("price_texts", []) or text.splitlines():
            price, currency = parse_price(line)
            if price is not None:
                break
    date = None
    date_match = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", text)
    if date_match:
        try:
            date = datetime.strptime(date_match[1], "%d/%m/%Y").date().isoformat()
        except ValueError:
            pass
    year, brand, model, variant = parse_identity(title)
    image = card.get("image_url", "")
    image_host = urlparse(image).hostname
    if image_host == "collectingcars.imgix.net":   # same files, newer CDN host
        image = image.replace("collectingcars.imgix.net", "images.collectingcars.com", 1)
    elif image_host != "images.collectingcars.com":
        image = ""
    slug = match[1]
    return dict(id=slug, url=f"https://collectingcars.com/it/for-sale/{slug}",
                title=title, year=year, brand=brand, model=model, variant=variant,
                body_type=classify(title), classification="Titolo (euristica)",
                price=price, currency=currency,
                price_status="login_required" if locked else ("visible" if price is not None else "unavailable"),
                sold_date=date, country=card.get("country", ""), location=card.get("location", ""),
                image_url=image, drive_side="left", source_page=page,
                fetched_at=fetched_at or now(), raw_text=text)

def page_url(page):
    return "https://collectingcars.com/it/sold?"+urlencode({"page":page,"refinementList[driveSide]":"left"})


class FetchError(RuntimeError):
    pass


def fetch_html(url, timeout=25):
    headers={
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        "Accept":"text/html,application/xhtml+xml",
        "Accept-Language":"it-IT,it;q=0.9,en;q=0.6",
        "Accept-Encoding":"gzip",
    }
    # Optional: the Cookie header of the owner's own logged-in session, to see reserved prices.
    cookie=os.environ.get("COLLECTINGCARS_COOKIE","").strip()
    if cookie:
        headers["Cookie"]=cookie
    request=urllib.request.Request(url,headers=headers)
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response:
            body=response.read()
            if response.headers.get("Content-Encoding")=="gzip":
                body=gzip.decompress(body)
            return body.decode("utf-8","replace")
    except urllib.error.HTTPError as exc:
        if exc.code in (403,429,503):
            raise FetchError(f"Il sito ha rifiutato la richiesta (HTTP {exc.code}). Riprova più tardi.") from exc
        raise FetchError(f"Errore del sito (HTTP {exc.code}).") from exc
    except (OSError,ValueError) as exc:
        raise FetchError("Collecting Cars non raggiungibile. Riprova più tardi.") from exc


IMAGE_HOSTS = ("images.collectingcars.com", "collectingcars.imgix.net")


def _image(container):
    for img in container.find_all("img"):
        if "flagcdn.com" in (img.get("src") or ""):
            continue
        candidates=[img.get("src"),img.get("data-src")]
        for srcset in (img.get("srcset"),img.get("data-srcset")):
            if srcset:
                candidates+=[x.strip().split()[0] for x in srcset.split(",") if x.strip()]
        for raw in candidates:
            if not raw:
                continue
            url=urlparse(urljoin("https://collectingcars.com/",raw))
            if url.hostname in IMAGE_HOSTS:
                return url.geturl()
            inner=parse_qs(url.query).get("url",[""])[0]       # Next.js image proxy
            if inner and urlparse(inner).hostname in IMAGE_HOSTS:
                return inner
    return ""


def parse_listing(html):
    """Cards rendered on one /sold page, plus the site's total and pagination."""
    soup=BeautifulSoup(html,"lxml")
    cards=[]
    for heading in soup.find_all("h3"):
        anchor=heading.find_parent("a",href=re.compile(r"/for-sale/"))
        if not anchor:
            continue
        container=anchor.find_parent("li") or anchor.parent
        flag=anchor.find("img",src=re.compile(r"flagcdn\.com"))
        place=flag.parent.parent if flag and flag.parent else None
        cards.append(dict(
            title=heading.get_text(" ",strip=True),
            url=urljoin("https://collectingcars.com/",anchor["href"]),
            text=anchor.get_text("\n",strip=True),
            price_texts=[p.get_text(" ",strip=True) for p in anchor.find_all("p")],
            country=flag.get("alt","") if flag else "",
            location=place.get_text(" ",strip=True) if place else "",
            image_url=_image(container),
        ))
    pages=[int(n) for a in soup.select('a[href*="/sold?"]')
           for n in parse_qs(urlparse(a["href"]).query).get("page",[]) if n.isdigit()]
    body=soup.get_text(" ",strip=True)
    count=re.search(r"(\d[\d.,\s]*)\s+lotti\b",body,re.I)
    return dict(cards=cards,
                total_pages=max(pages) if pages else None,
                expected=int(re.sub(r"\D","",count[1])) if count else None,
                challenge=bool(re.search(r"just a moment|verify you are human|checking your browser|access denied",body[:1500],re.I)))


def fingerprint(cards):
    return hashlib.sha256("|".join(c["id"] for c in cards).encode()).hexdigest()
