#!/usr/bin/env python3
"""Genera schedule.json con el horario programado (GTFS) de Tranvías de A Coruña
solo para las paradas de Mi bus. Lo ejecuta GitHub Actions cada semana.

Formato de salida:
{
  "generated": "2026-11-25T10:00:00Z",
  "stops": {"50": {"gtfs": "...", "name": "...", "m": 12}},          # m = metros entre parada iTranvías y GTFS
  "services": {"S1": [[stop, "12", dep, arr, walk], ...]},           # dep/arr en minutos desde medianoche
  "days": {"2026-11-25": ["S1", "S3"]}
}
arr = minuto de llegada a la parada de bajada más cercana al destino (o null)
walk = minutos andando desde esa parada al destino (o null)
"""
import csv, io, json, math, sys, urllib.request, zipfile, datetime

URLS = [
    "https://files.mobilitydatabase.org/mdb-2767/latest/mdb-2767.zip",
    "https://nap.transportes.gob.es/api/Fichero/download/1574",
]

# Paradas de iTranvías: (lat, lon), trayecto y destino
STOPS = {
    50: (43.362445, -8.416768, "ida"),
    94: (43.361055, -8.421567, "ida"),
    40: (43.356505, -8.403273, "vuelta"),
    269: (43.35168, -8.404437, "vuelta"),
    120: (43.354375, -8.410077, "vuelta"),
}
WORK = (43.3548, -8.4046)   # El Corte Inglés, Ramón y Cajal 57 (aprox.)
HOME = (43.3617, -8.4190)   # entre Rda. de Nelle 109 y Rda. de Outeiro 249 (aprox.)
DAYS_AHEAD = 21


def dist_m(a, b):
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    dy = (a[0] - b[0]) * 110570
    return math.hypot(dx, dy)


def tmin(s):
    if not s:
        return None
    h, m, *_ = s.strip().split(":")
    return int(h) * 60 + int(m)


def download():
    last = None
    for u in URLS:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "mibus-schedule/1.0"})
            data = urllib.request.urlopen(req, timeout=120).read()
            zipfile.ZipFile(io.BytesIO(data))  # valida
            print("GTFS descargado de", u, len(data), "bytes")
            return data
        except Exception as e:  # noqa
            print("Fallo descargando", u, e)
            last = e
    raise SystemExit(f"No se pudo descargar el GTFS: {last}")


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    z = zipfile.ZipFile(io.BytesIO(download()))
    names = set(z.namelist())

    stops = {}
    for r in rows(z, "stops.txt"):
        try:
            stops[r["stop_id"]] = (float(r["stop_lat"]), float(r["stop_lon"]), r.get("stop_name", ""))
        except (ValueError, KeyError):
            pass

    # Emparejar cada parada de iTranvías con la parada GTFS más cercana
    mapping, out_stops = {}, {}
    for sid, (la, lo, trip) in STOPS.items():
        best = min(stops.items(), key=lambda kv: dist_m((la, lo), kv[1][:2]))
        d = dist_m((la, lo), best[1][:2])
        print(f"Parada {sid} -> GTFS {best[0]} '{best[1][2]}' a {d:.0f} m")
        if d > 60:
            print(f"  AVISO: demasiado lejos, se ignora la parada {sid}")
            continue
        mapping[best[0]] = sid
        out_stops[str(sid)] = {"gtfs": best[0], "name": best[1][2], "m": round(d)}

    routes = {r["route_id"]: (r.get("route_short_name") or r.get("route_long_name") or "").strip() for r in rows(z, "routes.txt")}
    trips = {r["trip_id"]: (r["route_id"], r["service_id"]) for r in rows(z, "trips.txt")}

    # Paso 1: viajes que pasan por nuestras paradas
    wanted = set()
    for r in rows(z, "stop_times.txt"):
        if r["stop_id"] in mapping:
            wanted.add(r["trip_id"])
    print("Viajes que pasan por las paradas:", len(wanted))

    # Paso 2: secuencia completa de esos viajes
    seqs = {}
    for r in rows(z, "stop_times.txt"):
        if r["trip_id"] in wanted:
            seqs.setdefault(r["trip_id"], []).append((int(r["stop_sequence"]), r["stop_id"], tmin(r["arrival_time"]), tmin(r["departure_time"])))

    services = {}
    for tid, seq in seqs.items():
        seq.sort()
        route_id, service_id = trips.get(tid, (None, None))
        line = routes.get(route_id, "?")
        for i, (_, gs, _, dep) in enumerate(seq):
            if gs not in mapping or dep is None:
                continue
            sid = mapping[gs]
            target = WORK if STOPS[sid][2] == "ida" else HOME
            arr = walk = None
            best_d = 1e9
            for (_, gs2, a2, d2) in seq[i + 1:]:
                if gs2 not in stops:
                    continue
                dd = dist_m(stops[gs2][:2], target)
                if dd < best_d:
                    best_d, arr = dd, (a2 if a2 is not None else d2)
            if best_d <= 900:
                walk = max(1, math.ceil(best_d * 1.3 / 75))
            else:
                arr = None
            services.setdefault(service_id, []).append([sid, line, dep, arr, walk])

    for v in services.values():
        v.sort(key=lambda x: (x[2], x[0]))

    # Calendario: qué servicios funcionan cada día
    today = datetime.date.today()
    dates = [today + datetime.timedelta(days=i) for i in range(DAYS_AHEAD)]
    active = {d.isoformat(): set() for d in dates}
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if "calendar.txt" in names:
        for r in rows(z, "calendar.txt"):
            if r["service_id"] not in services:
                continue
            s = datetime.datetime.strptime(r["start_date"], "%Y%m%d").date()
            e = datetime.datetime.strptime(r["end_date"], "%Y%m%d").date()
            for d in dates:
                if s <= d <= e and r[wd[d.weekday()]] == "1":
                    active[d.isoformat()].add(r["service_id"])
    if "calendar_dates.txt" in names:
        for r in rows(z, "calendar_dates.txt"):
            if r["service_id"] not in services:
                continue
            d = datetime.datetime.strptime(r["date"], "%Y%m%d").date().isoformat()
            if d in active:
                (active[d].add if r["exception_type"] == "1" else active[d].discard)(r["service_id"])

    # Renombrar servicios a claves cortas
    keys = {s: f"S{i}" for i, s in enumerate(sorted(services))}
    out = {
        "generated": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "stops": out_stops,
        "services": {keys[s]: v for s, v in services.items()},
        "days": {d: sorted(keys[s] for s in ss) for d, ss in active.items()},
    }
    with open("schedule.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(v) for v in services.values())
    print(f"schedule.json: {len(services)} servicios, {total} pasos, {len(dates)} días")
    for d in list(out["days"])[:3]:
        n = sum(len(out["services"][k]) for k in out["days"][d])
        print(" ", d, "->", n, "pasos")
    if total == 0:
        sys.exit("No se encontró ningún paso: revisar emparejamiento de paradas")


if __name__ == "__main__":
    main()
