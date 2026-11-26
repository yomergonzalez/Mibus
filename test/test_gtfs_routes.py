"""python3 -m unittest discover -s test -p 'test_*.py'"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from gtfs_build import build_routes  # noqa: E402


class BuildRoutes(unittest.TestCase):
    def test_orden_minutos_y_variantes(self):
        trips = {f't{i}': {'route_id': '1200', 'direction_id': '0'} for i in range(10)}
        trips['v'] = {'route_id': '1200', 'direction_id': '0'}
        trips['b'] = {'route_id': '1200', 'direction_id': '1'}
        seqs = {}
        for i in range(10):  # recorrido normal, desordenado a propósito
            t0 = 400 + i * 20
            seqs[f't{i}'] = [(3, '40', t0 + 14 + (i % 2)), (1, '50', t0), (2, '80', t0 + 3)]
        seqs['v'] = [(1, '50', 900), (2, '99', 905)]   # variante rara (<10 %): se ignora
        seqs['b'] = [(1, '40', 500), (2, '50', 515)]   # el otro sentido
        r = build_routes(trips, seqs)
        self.assertEqual(len(r['1200']['0']), 1)
        v = r['1200']['0'][0]
        self.assertEqual(v['n'], 10)
        self.assertEqual(v['p'], [[50, 0], [80, 3], [40, 15]])  # mediana de 14 y 15
        self.assertEqual(r['1200']['1'][0]['p'], [[40, 0], [50, 15]])


if __name__ == '__main__':
    unittest.main()
