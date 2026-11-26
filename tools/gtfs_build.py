#!/usr/bin/env python3
"""Genera los horarios programados de Mi bus a partir del GTFS de Tranvías.

Uso:  python3 tools/gtfs_build.py RUTA/AL/GTFS.zip

El GTFS se descarga del Punto de Acceso Nacional (nap.transportes.gob.es,
"Autobús urbano de la Coruña"). Escribe en gtfs/ (se publica en GitHub Pages):

  gtfs/index.json        versión, tipos de día y qué tipos rigen cada fecha
  gtfs/meta.json         catálogo de respaldo, mismo formato que /api/meta
  gtfs/stops/<id>.json   horas de paso por línea y tipo de día
  gtfs/lines/<id>.json   salidas desde cabecera por sentido y tipo de día
  gtfs/routes.json       recorridos: paradas en orden por línea y sentido, con minutos
                         desde la cabecera (lo usa planner.js para elegir paradas)

Los IDs de parada y de línea del GTFS son los mismos que usa iTranvías.
Las horas van en minutos desde las 00:00. Solo usa la biblioteca estándar.
"""
import csv
import datetime as dt
import io
import json
import os
import shutil
import sys
import zipfile
from collections import defaultdict

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gtfs')
DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

# El GTFS no trae colores; son los de iTranvías (func=7).
COLORS = {
    '100': '#982135', '200': '#FDB515', '300': '#C0910F', '301': '#D3B255', '400': '#00B17A',
    '500': '#6792BC', '600': '#F96B09', '601': '#FC9751', '700': '#019FA2', '800': '#FDCB5A',
    '1100': '#F94F8E', '1200': '#019F02', '1400': '#025BBF', '1500': '#4DB94C', '1700': '#A15011',
    '1800': '#35264F', '1801': '#35264F', '1900': '#E46078', '2000': '#982135', '2100': '#355787',
    '2200': '#934165', '2300': '#8E47AD', '2301': '#AE7FC5', '2400': '#056E74', '2450': '#D61D3F',
    '2451': '#D61D3F',
}


def ymd(d):
    return d.strftime('%Y%m%d')


def parse_date(s):
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:]))


def read(z, name):
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))


def build_routes(trips, seqs, max_variants=4, min_share=0.1):
    """Recorridos por línea y sentido: {route_id: {direction_id: [variante, ...]}}.

    Cada variante es {"n": viajes, "p": [[stop_id, minutos desde la cabecera], ...]} con las
    paradas en orden de paso. Los minutos son la mediana de todos los viajes de esa variante.
    Se guardan las variantes con al menos el 10 % de los viajes del sentido (máx. 4), la más
    común primero: así entran los recorridos cortos o con desvío habitual.
    """
    pats = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for tid, lst in seqs.items():
        if len(lst) < 2:
            continue
        lst.sort()
        t = trips[tid]
        t0 = lst[0][2]
        key = tuple(sid for _, sid, _ in lst)
        pats[t['route_id']][t['direction_id'] or '0'][key].append([m - t0 for _, _, m in lst])
    out = {}
    for rid, dirs in sorted(pats.items(), key=lambda x: int(x[0])):
        out[rid] = {}
        for did, variants in sorted(dirs.items()):
            total = sum(len(v) for v in variants.values())
            ranked = sorted(variants.items(), key=lambda kv: -len(kv[1]))
            keep = [kv for i, kv in enumerate(ranked) if i == 0 or len(kv[1]) >= total * min_share][:max_variants]
            out[rid][did] = []
            for key, offs in keep:
                med = [sorted(col)[len(col) // 2] for col in zip(*offs)]
                out[rid][did].append({'n': len(offs), 'p': [[int(sid), m] for sid, m in zip(key, med)]})
    return out


def main(path):
    z = zipfile.ZipFile(path)
    cal = {r['service_id']: r for r in read(z, 'calendar.txt')}
    exc = defaultdict(list)
    for r in read(z, 'calendar_dates.txt'):
        exc[r['service_id']].append((r['date'], r['exception_type']))
    routes = {r['route_id']: r for r in read(z, 'routes.txt')}
    stops = {r['stop_id']: r for r in read(z, 'stops.txt')}
    trips = {r['trip_id']: r for r in read(z, 'trips.txt')}

    # Solo interesan las fechas desde el inicio del feed (las anteriores ya pasaron).
    start = min(r['start_date'] for r in cal.values())
    end = max(r['end_date'] for r in cal.values())

    def active(sid):
        out = set()
        r = cal.get(sid)
        if r:
            d, last = parse_date(r['start_date']), parse_date(r['end_date'])
            while d <= last:
                if r[DAYS[d.weekday()]] == '1':
                    out.add(ymd(d))
                d += dt.timedelta(days=1)
        for date, t in exc.get(sid, []):
            if t == '1':
                out.add(date)
            elif t == '2':
                out.discard(date)
        return frozenset(x for x in out if start <= x <= end)

    # Cada viaje tiene su propio service_id; se agrupan por el conjunto de fechas en que circulan.
    svc_pat, pats = {}, {}
    for sid in set(cal) | set(exc):
        dates = active(sid)
        if not dates:
            continue
        if dates not in pats:
            pats[dates] = len(pats)
        svc_pat[sid] = pats[dates]
    pat_dates = {i: d for d, i in pats.items()}

    # Renumerar los tipos por número de fechas (el más común primero) y ponerles nombre.
    order = sorted(pat_dates, key=lambda i: (-len(pat_dates[i]), min(pat_dates[i])))
    renum = {old: new for new, old in enumerate(order)}
    tipos = []
    for old in order:
        ds = sorted(pat_dates[old])
        wd = {parse_date(x).weekday() for x in ds}
        if wd <= {0, 1, 2, 3, 4}:
            # Uno o dos días sueltos entre semana con su propio horario: festivos (8 dic, 25 dic…)
            nombre = 'festivo' if len(ds) <= 2 else 'laborable'
        elif wd == {5}:
            nombre = 'sábado'
        elif 5 not in wd and 6 in wd:
            nombre = 'domingo o festivo'
        else:
            nombre = 'especial'
        tipos.append({'id': renum[old], 'nombre': nombre, 'fechas': len(ds), 'desde': ds[0], 'hasta': ds[-1]})

    dias = defaultdict(set)
    for old, ds in pat_dates.items():
        for d in ds:
            dias[d].add(renum[old])

    times = defaultdict(lambda: defaultdict(lambda: defaultdict(set)))
    trip_pat = {}
    for tid, t in trips.items():
        p = svc_pat.get(t['service_id'])
        if p is not None:
            trip_pat[tid] = renum[p]
    first = {}  # trip_id -> (stop_sequence, stop_id, minutos) de la primera parada del viaje
    seqs = defaultdict(list)  # trip_id -> [(stop_sequence, stop_id, minutos)] para los recorridos
    with z.open('stop_times.txt') as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')):
            p = trip_pat.get(r['trip_id'])
            if p is None:
                continue
            h, m, _ = (int(x) for x in (r['departure_time'] or r['arrival_time']).split(':'))
            times[r['stop_id']][trips[r['trip_id']]['route_id']][p].add(h * 60 + m)
            seq = int(r['stop_sequence'])
            seqs[r['trip_id']].append((seq, r['stop_id'], h * 60 + m))
            if r['trip_id'] not in first or seq < first[r['trip_id']][0]:
                first[r['trip_id']] = (seq, r['stop_id'], h * 60 + m)

    # Salidas desde cabecera por línea y sentido (para horario_linea, sin pedir func=8)
    deps = defaultdict(lambda: defaultdict(lambda: {'desde': defaultdict(int), 'hacia': defaultdict(int), 't': defaultdict(set)}))
    for tid, (seq, sid, mins) in first.items():
        t = trips[tid]
        d = deps[t['route_id']][t['direction_id'] or '0']
        d['desde'][sid] += 1
        d['hacia'][(t.get('trip_headsign') or '').strip()] += 1
        d['t'][trip_pat[tid]].add(mins)

    out = os.path.abspath(OUT)
    for sub in ('stops', 'lines'):
        shutil.rmtree(os.path.join(out, sub), ignore_errors=True)
        os.makedirs(os.path.join(out, sub), exist_ok=True)

    def dump(rel, obj):
        with open(os.path.join(out, rel), 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))

    def stop_name(s):
        return (s.get('stop_desc') or '').strip() or s['stop_name'].strip()

    n = 0
    for sid, lines in times.items():
        s = stops.get(sid)
        if not s:
            continue
        dump(os.path.join('stops', sid + '.json'), {
            'id': int(sid),
            'n': stop_name(s),
            'l': {lid: {str(p): sorted(v) for p, v in sorted(pp.items())} for lid, pp in sorted(lines.items(), key=lambda x: int(x[0]))},
        })
        n += 1

    for rid, dirs in deps.items():
        r = routes.get(rid, {})
        out_dirs = {}
        for did, d in sorted(dirs.items()):
            sid = max(d['desde'], key=d['desde'].get)
            out_dirs[did] = {
                'desde': stop_name(stops[sid]) if sid in stops else sid,
                'hacia': max(d['hacia'], key=d['hacia'].get),
                's': {str(p): sorted(v) for p, v in sorted(d['t'].items())},
            }
        dump(os.path.join('lines', rid + '.json'), {'id': int(rid), 'n': r.get('route_short_name', rid), 'd': out_dirs})

    dump('routes.json', build_routes(trips, seqs))

    meta = {'lines': {}, 'stops': {}, 'pos': {}}
    for rid, r in routes.items():
        o, _, d = r['route_long_name'].partition('-')
        meta['lines'][rid] = {'n': r['route_short_name'], 'c': COLORS.get(rid, ''), 'o': o.strip(), 'd': d.strip()}
    for sid, s in stops.items():
        meta['stops'][sid] = stop_name(s)
        meta['pos'][sid] = [float(s['stop_lat']), float(s['stop_lon'])]
    dump('meta.json', meta)

    feed = os.path.basename(path)
    dump('index.json', {
        'fuente': 'GTFS Tranvías de A Coruña (nap.transportes.gob.es)',
        'fichero': feed,
        'generado': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'desde': start, 'hasta': end,
        'tipos': tipos,
        'dias': {d: sorted(v) for d, v in sorted(dias.items())},
    })
    print(f'{n} paradas, {len(tipos)} tipos de día, {start}–{end} → {out}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
