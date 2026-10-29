"""Canopy — a shared map of USFS and TNC partnerships.

No accounts. Anyone who can open the app can add and remove partnerships.
"""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = Path(os.environ.get("CANOPY_DB", DATA / "canopy.db"))

ORGS = {
    "usfs": "USFS",
    "tnc": "TNC",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    office TEXT,
    org TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    tnc_id INTEGER NOT NULL REFERENCES people(id),
    usfs_id INTEGER NOT NULL REFERENCES people(id),
    place TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

LINKS_TABLE = """
CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    tnc_id INTEGER NOT NULL REFERENCES people(id),
    usfs_id INTEGER NOT NULL REFERENCES people(id),
    place TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

app = Flask(__name__)
app.config.update(MAX_CONTENT_LENGTH=32_000)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def recreate_links(db: sqlite3.Connection, rows: list[tuple]) -> None:
    db.execute("DROP TABLE IF EXISTS links")
    db.executescript(LINKS_TABLE)
    db.executemany(
        """
        INSERT INTO links (tnc_id, usfs_id, place, purpose, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def init_db() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)
        db.execute("PRAGMA journal_mode = WAL")
        columns = {row[1] for row in db.execute("PRAGMA table_info(people)")}
        if "org" not in columns:
            db.execute("ALTER TABLE people ADD COLUMN org TEXT")
        link_cols = {row[1] for row in db.execute("PRAGMA table_info(links)")}
        if "purpose" not in link_cols:
            old = db.execute(
                """
                SELECT l.person_id, l.relationship, l.created_at, l.updated_at,
                       u.person_id, op.org, op.office, cp.org, cp.office, op.name, cp.name
                FROM links l
                JOIN users u ON u.id = l.owner_id
                JOIN people op ON op.id = u.person_id
                JOIN people cp ON cp.id = l.person_id
                """
            ).fetchall()
            kept = []
            phrases = {
                "together": "Working together",
                "team": "Same team",
                "project": "Shared project",
                "mentor": "Mentoring",
                "advise": "Advice",
            }
            for row in old:
                (
                    person_id,
                    relationship,
                    created_at,
                    updated_at,
                    owner_person,
                    owner_org,
                    owner_office,
                    colleague_org,
                    colleague_office,
                    owner_name,
                    colleague_name,
                ) = row
                if owner_org == "tnc" and colleague_org == "usfs":
                    tnc_id, usfs_id = owner_person, person_id
                    place = colleague_office or owner_office
                elif owner_org == "usfs" and colleague_org == "tnc":
                    tnc_id, usfs_id = person_id, owner_person
                    place = owner_office or colleague_office
                else:
                    raise RuntimeError(
                        f"Cannot reshape the link between {owner_name} and {colleague_name}."
                    )
                place = re.sub(r"\s+", " ", str(place or "")).strip() or "Not recorded"
                kept.append(
                    (
                        tnc_id,
                        usfs_id,
                        place,
                        phrases.get(relationship, "Working together"),
                        created_at,
                        updated_at,
                    )
                )
            recreate_links(db, kept)
            link_cols = {row[1] for row in db.execute("PRAGMA table_info(links)")}
        if "owner_id" in link_cols:
            rows = db.execute(
                """
                SELECT tnc_id, usfs_id, place, purpose, created_at, updated_at
                FROM links
                """
            ).fetchall()
            recreate_links(db, rows)
        db.execute("DROP TABLE IF EXISTS users")
        db.execute("CREATE INDEX IF NOT EXISTS idx_links_tnc ON links(tnc_id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_links_usfs ON links(usfs_id)")


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH, timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def fail(message: str, code: int = 400):
    return jsonify(error=message), code


def name_key(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().casefold()


def clean_name(raw) -> str:
    name = re.sub(r"\s+", " ", str(raw or "")).strip()
    if len(name) < 2 or len(name) > 80:
        raise ValueError("Enter a name, up to 80 characters.")
    if any(ord(char) < 32 for char in name):
        raise ValueError("That name isn't valid.")
    return name


def clean_phrase(raw, label: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if len(text) < 2 or len(text) > limit:
        raise ValueError(f"Enter {label}, up to {limit} characters.")
    if any(ord(char) < 32 for char in text):
        raise ValueError(f"That {label} isn't valid.")
    return text


def network_payload() -> dict:
    db = get_db()
    people = [
        {
            "id": row["id"],
            "name": row["name"],
            "office": row["office"] or "",
            "org": row["org"] or "",
        }
        for row in db.execute(
            """
            SELECT id, name, office, org
            FROM people
            ORDER BY name COLLATE NOCASE
            """
        )
    ]
    links = [
        {
            "id": row["id"],
            "tnc_id": row["tnc_id"],
            "usfs_id": row["usfs_id"],
            "place": row["place"],
            "purpose": row["purpose"],
            "updated_at": row["updated_at"],
        }
        for row in db.execute(
            """
            SELECT id, tnc_id, usfs_id, place, purpose, updated_at
            FROM links
            """
        )
    ]
    return {"people": people, "links": links}


def find_or_create_person(db, name: str, office: str, org: str) -> sqlite3.Row:
    key = name_key(name)
    person = db.execute("SELECT * FROM people WHERE name_key = ?", (key,)).fetchone()
    if person is None:
        cur = db.execute(
            "INSERT INTO people (name, name_key, office, org, created_at) VALUES (?, ?, ?, ?, ?)",
            (name, key, office or None, org, now()),
        )
        return db.execute("SELECT * FROM people WHERE id = ?", (cur.lastrowid,)).fetchone()
    next_office = person["office"]
    next_org = person["org"]
    if office and not person["office"]:
        next_office = office
    if org and not person["org"]:
        next_org = org
    if next_office != person["office"] or next_org != person["org"]:
        db.execute(
            "UPDATE people SET office = ?, org = ? WHERE id = ?",
            (next_office, next_org, person["id"]),
        )
        person = db.execute("SELECT * FROM people WHERE id = ?", (person["id"],)).fetchone()
    return person


def prune_person(db, person_id: int) -> None:
    linked = db.execute(
        "SELECT 1 FROM links WHERE tnc_id = ? OR usfs_id = ?",
        (person_id, person_id),
    ).fetchone()
    if linked is None:
        db.execute("DELETE FROM people WHERE id = ?", (person_id,))


@app.before_request
def guard_writes():
    if request.method in {"POST", "PATCH", "DELETE"} and request.path.startswith("/api/"):
        if request.headers.get("X-Canopy") != "1":
            return fail("Blocked request.", 403)
    return None


@app.after_request
def secure_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/network")
def network():
    return jsonify(network_payload())


def person_for_side(db, name: str, org: str, office: str = ""):
    existing = db.execute(
        "SELECT org FROM people WHERE name_key = ?",
        (name_key(name),),
    ).fetchone()
    if existing and existing["org"] and existing["org"] != org:
        return None, fail(
            f"{name} is already listed as {ORGS.get(existing['org'], 'another organization')}."
        )
    person = find_or_create_person(db, name, office, org)
    if person["org"] != org:
        return None, fail(
            f"{person['name']} is already listed as {ORGS.get(person['org'], 'another organization')}."
        )
    return person, None


@app.post("/api/connections")
def add_connection():
    data = request.get_json(silent=True) or {}
    try:
        tnc_name = clean_name(data.get("tnc_name"))
        usfs_name = clean_name(data.get("usfs_name"))
        place = clean_phrase(data.get("place"), "the forest or branch", 80)
        purpose = clean_phrase(data.get("purpose"), "the purpose", 140)
    except ValueError as exc:
        return fail(str(exc))
    if name_key(tnc_name) == name_key(usfs_name):
        return fail("Enter two different people, one from TNC and one from USFS.")

    db = get_db()
    tnc, error = person_for_side(db, tnc_name, "tnc")
    if error:
        return error
    usfs, error = person_for_side(db, usfs_name, "usfs", place)
    if error:
        return error
    existing = db.execute(
        "SELECT id FROM links WHERE tnc_id = ? AND usfs_id = ?",
        (tnc["id"], usfs["id"]),
    ).fetchone()
    stamp = now()
    if existing:
        db.execute(
            "UPDATE links SET place = ?, purpose = ?, updated_at = ? WHERE id = ?",
            (place, purpose, stamp, existing["id"]),
        )
        message = f"Updated {tnc['name']} and {usfs['name']}."
    else:
        db.execute(
            """
            INSERT INTO links (tnc_id, usfs_id, place, purpose, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (tnc["id"], usfs["id"], place, purpose, stamp, stamp),
        )
        message = f"Added {tnc['name']} and {usfs['name']}."
    db.commit()
    payload = network_payload()
    payload["focus_id"] = usfs["id"]
    payload["message"] = message
    return jsonify(payload), 201


@app.delete("/api/connections/<int:link_id>")
def delete_connection(link_id: int):
    db = get_db()
    row = db.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
    if row is None:
        return fail("That partnership is already gone.", 404)
    tnc_id = row["tnc_id"]
    usfs_id = row["usfs_id"]
    db.execute("DELETE FROM links WHERE id = ?", (link_id,))
    prune_person(db, tnc_id)
    prune_person(db, usfs_id)
    db.commit()
    payload = network_payload()
    payload["message"] = "Removed that partnership."
    return jsonify(payload)


@app.errorhandler(HTTPException)
def http_error(exc: HTTPException):
    if request.path.startswith("/api/"):
        return fail(exc.description or "Request failed.", exc.code or 500)
    return exc


@app.errorhandler(Exception)
def unexpected(exc: Exception):
    if isinstance(exc, HTTPException):
        return http_error(exc)
    app.logger.exception("request failed")
    return fail("Something went wrong on the server.", 500)


init_db()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8741"))
    from waitress import serve

    print(f"Canopy is running at http://127.0.0.1:{port}", flush=True)
    serve(app, host="0.0.0.0", port=port, threads=8)
