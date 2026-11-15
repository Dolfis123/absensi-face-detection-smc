"""
Penyusun roster dengan Google OR-Tools CP-SAT.

Berbeda dengan penyusun lama (memilih hari demi hari), solver melihat seluruh periode
sekaligus: semua aturan WAJIB pasti dipenuhi, atau solver menyatakan mustahil beserta
kelompok aturan yang bentrok. Aturan "sebaiknya" (pemerataan) dioptimalkan bersamaan.

Isi tiap sel: 'S1', 'S2', 'SG' (Shift Siang), 'FULL' (shift tetap, mis. Shift Penuh
Koordinator), 'OFF', atau None untuk hari libur nasional (tidak dijadwalkan).

Komposisi harian: Shift 1 tepat shift1Count orang, Shift Siang tepat siangCount orang
(hanya yang boleh, mis. bukan petugas perempuan), sisanya Shift 2.
"""
from __future__ import annotations

import math
from typing import Any

from ortools.sat.python import cp_model

WEEKEND = {0, 6}  # 0 = Minggu, 6 = Sabtu


def _build(req: dict[str, Any], *, short_rest: bool = True, off_cap: bool = True, staffing: bool = True):
    emps = req["employees"]
    dates = req["dates"]  # [{date, weekday, holiday}]
    off_per_week = int(req.get("offPerWeek", 1))
    n_s1 = int(req.get("shift1Count", 3))
    n_sg = int(req.get("siangCount", 0))
    prev = {int(k): v for k, v in (req.get("prevDay") or {}).items()}

    m = cp_model.CpModel()
    work = [i for i, d in enumerate(dates) if not d["holiday"]]
    wd = [d["weekday"] for d in dates]
    rot = [e for e in emps if not e["fixed"]]
    fixed = [e for e in emps if e["fixed"]]

    S1: dict = {}
    S2: dict = {}
    SG: dict = {}
    OFF: dict = {}
    FULL: dict = {}
    for e in emps:
        eid = e["id"]
        for i in work:
            OFF[eid, i] = m.NewBoolVar(f"off_{eid}_{i}")
            if e["fixed"]:
                FULL[eid, i] = m.NewBoolVar(f"full_{eid}_{i}")
                m.AddExactlyOne([FULL[eid, i], OFF[eid, i]])
            else:
                S1[eid, i] = m.NewBoolVar(f"s1_{eid}_{i}")
                S2[eid, i] = m.NewBoolVar(f"s2_{eid}_{i}")
                SG[eid, i] = m.NewBoolVar(f"sg_{eid}_{i}")
                m.AddExactlyOne([S1[eid, i], S2[eid, i], SG[eid, i], OFF[eid, i]])
                if n_sg == 0 or wd[i] in e.get("noSiangDays", []):
                    m.Add(SG[eid, i] == 0)
            # Hari Off hanya pada hari yang diperbolehkan
            if wd[i] not in e["offDays"]:
                m.Add(OFF[eid, i] == 0)
            if not e["fixed"]:
                if wd[i] in e["noShift1Days"]:
                    m.Add(S1[eid, i] == 0)
                if wd[i] in e["noShift2Days"]:
                    m.Add(S2[eid, i] == 0)

    # Minggu = potongan 7 hari dari tanggal mulai
    weeks = [list(range(w, min(w + 7, len(dates)))) for w in range(0, len(dates), 7)]
    with_off = [e for e in emps if e["offDays"]]
    for wk in weeks:
        wk_work = [i for i in wk if not dates[i]["holiday"]]
        if not wk_work:
            continue
        for e in emps:
            allowed = [i for i in wk_work if wd[i] in e["offDays"]]
            m.Add(sum(OFF[e["id"], i] for i in wk_work) == min(off_per_week, len(allowed)))
        if off_cap:
            # Jumlah orang Off per hari dibuat rata, mis. 14 orang × 1 Off ÷ 7 hari = 2
            cap = math.ceil(len(with_off) * off_per_week / len(wk_work))
            for i in wk_work:
                m.Add(sum(OFF[e["id"], i] for e in emps) <= cap)

    # Komposisi harian tetap: Shift 1 = n_s1 orang, Shift Siang = n_sg orang, sisanya Shift 2
    if staffing:
        for i in work:
            m.Add(sum(S1[e["id"], i] for e in rot) == n_s1)
            m.Add(sum(SG[e["id"], i] for e in rot) == n_sg)
            m.Add(sum(S2[e["id"], i] for e in rot) >= 1)

    penalties = []
    # Pulang malam (S2) lalu besok masuk pagi (S1): wajib dihindari, KECUALI besoknya memang
    # wajib Shift 1 karena aturan orang itu (mis. Apriando kuliah malam) — itu hanya dikurangi.
    exempt_count = []
    for e in rot:
        eid = e["id"]
        for a, b in zip(range(len(dates)), range(1, len(dates))):
            if dates[a]["holiday"] or dates[b]["holiday"]:
                continue
            forced_s1 = wd[b] in e["noShift2Days"]
            if forced_s1:
                z = m.NewBoolVar(f"rest_{eid}_{b}")
                m.Add(z >= S2[eid, a] + S1[eid, b] - 1)
                exempt_count.append(z)
            elif short_rest:
                m.Add(S2[eid, a] + S1[eid, b] <= 1)
        first = work[0] if work else None
        if first == 0 and prev.get(eid) == "S2":
            if wd[0] in e["noShift2Days"]:
                z = m.NewBoolVar(f"rest_{eid}_0")
                m.Add(z >= S1[eid, 0])
                exempt_count.append(z)
            elif short_rest:
                m.Add(S1[eid, 0] == 0)
    # Kasus yang dikecualikan itu risiko yang disepakati: cukup dikurangi sedikit, jangan sampai
    # orangnya tidak pernah dapat Shift 2 sama sekali
    penalties.append(3 * sum(exempt_count) if exempt_count else 0)

    # Pulang 22:00 (Shift Siang) lalu masuk 08:00 besoknya: tidak dilarang, tetapi dihindari
    siang_then_s1 = []
    for e in rot:
        eid = e["id"]
        for a, b in zip(range(len(dates)), range(1, len(dates))):
            if dates[a]["holiday"] or dates[b]["holiday"]:
                continue
            z = m.NewBoolVar(f"sgs1_{eid}_{b}")
            m.Add(z >= SG[eid, a] + S1[eid, b] - 1)
            siang_then_s1.append(z)
    if siang_then_s1:
        penalties.append(4 * sum(siang_then_s1))

    # Orang dengan batasan banyak (mis. kuliah 4 hari): di hari bebasnya tetap dapat Shift 2
    # kira-kira sama porsinya dengan karyawan lain (±60% hari kerja)
    for e in rot:
        if len(e["noShift1Days"]) + len(e["noShift2Days"]) <= 1:
            continue
        free = [i for i in work if wd[i] not in e["noShift1Days"] and wd[i] not in e["noShift2Days"]]
        if not free:
            continue
        target = round(len(free) * 6 / 7 * 0.6)
        dev = m.NewIntVar(0, len(free), f"freedev_{e['id']}")
        s2_free = sum(S2[e["id"], i] + SG[e["id"], i] for i in free)
        m.Add(dev >= s2_free - target)
        m.Add(dev >= target - s2_free)
        penalties.append(20 * dev)

    # ── Pemerataan (aturan "sebaiknya") ──
    n_days = len(work)
    group = [e for e in rot if len(e["noShift1Days"]) + len(e["noShift2Days"]) <= 1]
    if len(group) >= 2:
        c1 = {e["id"]: sum(S1[e["id"], i] for i in work) for e in group}
        hi = m.NewIntVar(0, n_days, "s1_max")
        lo = m.NewIntVar(0, n_days, "s1_min")
        for e in group:
            m.Add(hi >= c1[e["id"]])
            m.Add(lo <= c1[e["id"]])
        penalties.append(100 * (hi - lo))

    # Shift Siang dibagi rata di antara yang bebas Shift Siang (pria tanpa batasan hari)
    sg_group = [e for e in rot if not e.get("noSiangDays")]
    if n_sg > 0 and len(sg_group) >= 2:
        csg = {e["id"]: sum(SG[e["id"], i] for i in work) for e in sg_group}
        ghi = m.NewIntVar(0, n_days, "sg_max")
        glo = m.NewIntVar(0, n_days, "sg_min")
        for e in sg_group:
            m.Add(ghi >= csg[e["id"]])
            m.Add(glo <= csg[e["id"]])
        penalties.append(100 * (ghi - glo))

    rotating_off = [e for e in emps if len(e["offDays"]) > 1]
    if len(rotating_off) >= 2:
        wkd = {e["id"]: sum(OFF[e["id"], i] for i in work if wd[i] in WEEKEND) for e in rotating_off}
        whi = m.NewIntVar(0, n_days, "we_max")
        wlo = m.NewIntVar(0, n_days, "we_min")
        for e in rotating_off:
            m.Add(whi >= wkd[e["id"]])
            m.Add(wlo <= wkd[e["id"]])
        penalties.append(40 * (whi - wlo))

        # Hari Off bergilir: tiap hari dalam seminggu sebanyak mungkin hanya sekali per orang
        total_off = math.ceil(len(weeks) * off_per_week / 7)
        for e in rotating_off:
            for day in range(7):
                days = [i for i in work if wd[i] == day]
                if not days:
                    continue
                ex = m.NewIntVar(0, len(days), f"wdx_{e['id']}_{day}")
                m.Add(ex >= sum(OFF[e["id"], i] for i in days) - max(1, total_off))
                penalties.append(15 * ex)

        # Teman Off berganti-ganti: dua orang sebaiknya Off bersamaan paling banyak sekali
        for x in range(len(rotating_off)):
            for y in range(x + 1, len(rotating_off)):
                a, b = rotating_off[x]["id"], rotating_off[y]["id"]
                both = []
                for i in work:
                    t = m.NewBoolVar(f"pair_{a}_{b}_{i}")
                    m.Add(t >= OFF[a, i] + OFF[b, i] - 1)
                    both.append(t)
                ex = m.NewIntVar(0, n_days, f"pairx_{a}_{b}")
                m.Add(ex >= sum(both) - 1)
                penalties.append(5 * ex)

    m.Minimize(sum(penalties))
    return m, S1, S2, SG, OFF, FULL, work


def solve(req: dict[str, Any]) -> dict[str, Any]:
    time_limit = float(req.get("timeLimit", 15))
    model, S1, S2, SG, OFF, FULL, work = _build(req)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = 8
    solver.parameters.random_seed = 7
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": "INFEASIBLE" if status == cp_model.INFEASIBLE else "UNKNOWN", "reasons": _diagnose(req, time_limit)}

    cells: dict[str, list] = {}
    for e in req["employees"]:
        eid = e["id"]
        row: list = []
        for i in range(len(req["dates"])):
            if i not in work:
                row.append(None)
            elif solver.Value(OFF[eid, i]):
                row.append("OFF")
            elif e["fixed"]:
                row.append("FULL")
            else:
                row.append("S1" if solver.Value(S1[eid, i]) else "SG" if solver.Value(SG[eid, i]) else "S2")
        cells[str(eid)] = row
    return {
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "objective": solver.ObjectiveValue(),
        "wallTime": round(solver.WallTime(), 2),
        "cells": cells,
    }


def _diagnose(req: dict[str, Any], time_limit: float) -> list[str]:
    """Cari kelompok aturan yang membuat roster mustahil, dengan melonggarkannya satu per satu."""
    checks = [
        ("short_rest", "Aturan pulang malam → besok masuk pagi tidak bisa dipenuhi untuk semua orang di periode ini."),
        ("off_cap", "Jumlah orang Off per hari tidak bisa dibuat rata (terlalu banyak yang hanya boleh Off di hari yang sama)."),
        ("staffing", "Jumlah orang Shift 1 dan Shift Siang per hari tidak bisa dipenuhi setiap hari (kurang orang yang boleh di shift itu)."),
    ]
    reasons = []
    for flag, text in checks:
        model, *_ = _build(req, **{flag: False})
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = min(5.0, time_limit)
        s.parameters.num_search_workers = 8
        if s.Solve(model) in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            reasons.append(text)
    if not reasons:
        reasons.append("Aturan karyawan (hari boleh Off, tidak bisa Shift 1/2/Siang) saling bertentangan. Periksa Aturan Karyawan.")
    return reasons
