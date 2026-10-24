"""한화 섹션 스크립트(대외보고 기한 계산, DART 종속기업 표 파싱)를 네트워크 없이 검증한다."""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hanwha" / "scripts"))

import build_deadlines  # noqa: E402
import fetch_dart_subs  # noqa: E402

DOC = """
<P>(3) 종속기업의 요약재무정보</P><P>(단위 : 천원)</P>
<TABLE><TBODY>
<TR><TH>회사명</TH><TH>자산</TH><TH>부채</TH><TH>영업수익</TH><TH>당기순손익</TH></TR>
<TR><TD>Pinetree Securities Corporation (Vietnam)</TD><TE>100,000,000</TE><TE>60,000,000</TE><TE>10,000,000</TE><TE>1,000,000</TE></TR>
<TR><TD>Pinetree Securities Pte. Ltd.</TD><TE>10,000,000</TE><TE>100,000</TE><TE>200,000</TE><TE>(1,000,000)</TE></TR>
<TR><TD>PT Ciptadana Sekuritas Asia</TD><TE>50,000,500</TE><TE>20,000,000</TE><TE>5,000,000</TE><TE>(500,000)</TE></TR>
<TR><TD>PT Ciptadana Asset Management</TD><TE>3,000,000</TE><TE>300,000</TE><TE>700,000</TE><TE>(400,000)</TE></TR>
<TR><TD>한화투자증권 신탁(주1)</TD><TE>1</TE><TE>1</TE><TE>1</TE><TE>1</TE></TR>
</TBODY></TABLE>
<TABLE><TR><TD>무관한 표</TD><TD>1</TD></TR></TABLE>
"""


class DartSubsTest(unittest.TestCase):
    def test_summary_table_parsed_in_millions(self):
        subs = fetch_dart_subs.parse_summary([DOC])
        self.assertEqual(sorted(subs), ["CAM", "CSA", "SG", "VN"])
        self.assertEqual(subs["VN"]["unit"], "천원")
        self.assertAlmostEqual(subs["VN"]["rev"], 10000.0)
        self.assertAlmostEqual(subs["SG"]["ni"], -1000.0)
        self.assertAlmostEqual(subs["CSA"]["assets"], 50000.5)

    def test_period_from_report_name(self):
        self.assertEqual(fetch_dart_subs.period_of("반기보고서 (2026.06)"), ("2026", "1H"))
        self.assertEqual(fetch_dart_subs.period_of("분기보고서 (2026.09)"), ("2026", "9M"))

    def test_latest_report_per_period_prefers_amendment(self):
        rows = [{"report_nm": "반기보고서 (2026.06)", "rcept_no": "20260813001503", "rcept_dt": "20260813"},
                {"report_nm": "사업보고서 (2025.12)", "rcept_no": "20260310002967", "rcept_dt": "20260310"},
                {"report_nm": "[기재정정]사업보고서 (2025.12)", "rcept_no": "20260401000001", "rcept_dt": "20260401"},
                {"report_nm": "주요사항보고서(유상증자결정)", "rcept_no": "20260501000001", "rcept_dt": "20260501"}]
        reps = fetch_dart_subs.periodic_reports(rows)
        self.assertEqual([(r["year"], r["period"]) for r in reps], [("2026", "1H"), ("2025", "FY")])
        self.assertEqual(reps[1]["rcept_no"], "20260401000001")
        self.assertEqual(fetch_dart_subs.label_of("2026", "9M"), "9M26")
        self.assertEqual(fetch_dart_subs.label_of("2025", "FY"), "FY2025")

    def test_invest_rows_in_millions_and_only_our_subsidiaries(self):
        api = [{"inv_prm": "Pinetree Securities Pte.Ltd.", "frst_acqs_de": "2020.04.01", "invstmnt_purps": "경영참여",
                "frst_acqs_amount": "1,725,000,000", "bsis_blce_acntbk_amount": "4,815,000,000", "incrs_dcrs_acqs_dsps_amount": "10,142,000,000",
                "trmend_blce_qy": "21,000,000", "trmend_blce_qota_rt": "100.00", "trmend_blce_acntbk_amount": "14,958,000,000",
                "recent_bsns_year_fnnr_sttus_thstrm_ntpf": "-1,534,000,000", "incrs_dcrs_evl_lstmn": "-"},
               {"inv_prm": "한국거래소", "trmend_blce_acntbk_amount": "9,000,000,000"}]
        rows = fetch_dart_subs.invest_rows(api)
        self.assertEqual(list(rows), ["SG"])
        sg = rows["SG"]
        self.assertEqual((sg["first_amount"], sg["end_book"], sg["chg_amount"], sg["recent_ni"]), (1725.0, 14958.0, 10142.0, -1534.0))
        self.assertEqual((sg["end_qty"], sg["end_stake"], sg["chg_valuation"], sg["first_date"]), (21000000.0, 100.0, None, "2020.04.01"))

    def test_stakes_from_notes_table(self):
        doc = "<TABLE><TR><TH>회사명</TH><TH>소재지</TH><TH>지분율(%)</TH></TR><TR><TD>PT Ciptadana Asset Management</TD><TD>인도네시아</TD><TD>80.00</TD></TR></TABLE>"
        self.assertEqual(fetch_dart_subs.parse_stakes([doc]), {"CAM": 80.0})

    def test_committed_dart_subs_is_public_schema(self):
        d = json.loads((ROOT / "hanwha" / "data" / "dart_subs.json").read_text(encoding="utf-8"))
        self.assertNotIn("compare", d)
        latest = d["periods"][-1]
        self.assertTrue(latest["subs"] and set(latest["subs"]) <= {"CAM", "CSA", "SG", "VN"})  # 빠진 법인은 화면 상단 예외로 표시
        self.assertIn(latest["period"], ("1Q", "1H", "9M", "FY"))
        self.assertTrue(all(p["report"]["url"].startswith("https://dart.fss.or.kr/") for p in d["periods"]))


class DartFetchFallbackTest(unittest.TestCase):
    """DART 응답 일부가 실패해도 이전 값으로 물러서거나 기존 값을 지킨다(네트워크 없이 get을 흉내 낸다)."""

    LIST = [{"report_nm": "분기보고서 (2026.09)", "rcept_no": "20261113000001", "rcept_dt": "20261113"},
            {"report_nm": "반기보고서 (2026.06)", "rcept_no": "20260813000001", "rcept_dt": "20260813"},
            {"report_nm": "사업보고서 (2025.12)", "rcept_no": "20260310000001", "rcept_dt": "20260310"}]
    SG_ROW = {"inv_prm": "Pinetree Securities Pte.Ltd.", "trmend_blce_qota_rt": "100.00", "trmend_blce_acntbk_amount": "9,000,000,000"}

    def run_main(self, invest_ok=(), docs_ok=True, prev=None, doc_fail=(), list_status="000"):
        import io as _io
        import tempfile
        import zipfile as _zip
        from unittest import mock

        buf = _io.BytesIO()
        with _zip.ZipFile(buf, "w") as z:
            z.writestr("a.xml", DOC)
        buf_empty = _io.BytesIO()
        with _zip.ZipFile(buf_empty, "w") as z:
            z.writestr("a.xml", "<html><body>표 없음</body></html>")

        def get(path, **q):
            if path == "list.json":
                return json.dumps({"status": list_status, "message": "m", "list": self.LIST if list_status == "000" else []}).encode()
            if path == "document.xml":
                if q["rcept_no"] in doc_fail:
                    raise TimeoutError("timed out")
                if not docs_ok:
                    return buf_empty.getvalue()
                return buf.getvalue()
            ok = (q["bsns_year"], q["reprt_code"]) in invest_ok
            return json.dumps({"status": "000", "list": [self.SG_ROW]} if ok else {"status": "013", "message": "no data"}).encode()

        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "dart_subs.json"
            if prev:
                out.write_text(json.dumps(prev), encoding="utf-8")
            with mock.patch.object(fetch_dart_subs, "get", get), mock.patch.object(fetch_dart_subs, "get_key", lambda _: "k"), \
                    mock.patch.object(fetch_dart_subs, "OUT", out), mock.patch("builtins.print"):
                fetch_dart_subs.main()
            return json.loads(out.read_text(encoding="utf-8")) if out.exists() else None

    def test_invest_falls_back_to_previous_interim_report(self):
        d = self.run_main(invest_ok={("2026", "11012")})  # 3분기 출자현황만 아직 없음
        self.assertEqual([p["label"] for p in d["periods"]], ["FY2025", "9M26"])
        self.assertEqual(d["invest"]["report"]["period"], "1H")
        self.assertEqual(d["invest"]["rows"]["SG"]["end_book"], 9000.0)

    def test_all_invest_calls_fail_keeps_previous_values(self):
        prev = {"stakes": {"SG": 100.0, "CSA": 80.0}, "stake_source": {"SG": "타법인 출자현황", "CSA": "타법인 출자현황"},
                "invest": {"report": {"name": "반기보고서 (2026.06)"}, "rows": {"SG": {"end_book": 9000.0, "end_stake": 100.0}}}}
        d = self.run_main(prev=prev)
        self.assertEqual(d["invest"]["report"]["name"], "반기보고서 (2026.06)")
        self.assertEqual(d["stakes"]["CSA"], 80.0)

    def test_no_summary_table_updates_only_filed(self):
        prev = {"periods": [{"label": "1H26"}], "filed": []}
        d = self.run_main(docs_ok=False, prev=prev)
        self.assertEqual(d["periods"], [{"label": "1H26"}])
        self.assertEqual([f["period"] for f in d["filed"]], ["9M", "1H", "FY"])

    def test_document_download_failure_keeps_periods(self):
        prev = {"periods": [{"label": "FY2025"}, {"label": "1H26"}], "filed": []}
        d = self.run_main(invest_ok={("2026", "11014")}, prev=prev, doc_fail={"20261113000001"})  # 3분기 원문만 시간 초과
        self.assertEqual(d["periods"], prev["periods"])  # 예전 기간으로 되돌아가지 않음
        self.assertEqual([f["period"] for f in d["filed"]], ["9M", "1H", "FY"])

    def test_list_error_status_changes_nothing(self):
        prev = {"periods": [{"label": "1H26"}], "filed": [{"period": "1H"}]}
        self.assertEqual(self.run_main(prev=prev, list_status="020"), prev)

    def test_invest_does_not_fall_back_below_previous_report(self):
        prev = {"invest": {"report": {"name": "분기보고서 (2026.09)", "year": "2026", "period": "9M", "rcept_no": "20261113000001"},
                           "rows": {"SG": {"end_book": 9500.0, "end_stake": 100.0}}}}
        d = self.run_main(invest_ok={("2026", "11012")}, prev=prev)  # 3분기 출자현황 일시 실패, 반기는 정상
        self.assertEqual(d["invest"]["report"]["period"], "9M")
        self.assertEqual(d["invest"]["rows"]["SG"]["end_book"], 9500.0)


class DeadlinesTest(unittest.TestCase):
    def test_periodic_deadline_moves_off_weekend(self):
        items = {x["id"]: x for x in build_deadlines.recurring(dt.date(2026, 10, 20))}
        self.assertEqual(items["periodic-2026-3Q"]["due"], "2026-11-16")  # 11/14(토) → 월
        self.assertEqual(items["annual-FY2026"]["due"], "2027-05-31")
        self.assertEqual(items["periodic-2026-FY"]["due"], "2027-03-31")

    def test_status_overdue_and_done(self):
        today = dt.date(2026, 10, 20)
        self.assertEqual(build_deadlines.status_of({"id": "a", "due": "2026-10-01"}, set(), today), "overdue")
        self.assertEqual(build_deadlines.status_of({"id": "a", "due": "2026-10-01"}, {"a"}, today), "done")
        self.assertEqual(build_deadlines.status_of({"id": "b", "due": ""}, set(), today), "upcoming")

    def test_ics_has_alarms_and_skips_done(self):
        items = [{"id": "x", "entity": "4사", "item": "테스트, 보고", "due": "2026-11-16", "basis": "근거", "status": "upcoming"},
                 {"id": "y", "entity": "4사", "item": "끝남", "due": "2026-11-17", "basis": "근거", "status": "done"}]
        text = build_deadlines.ics(items, dt.date(2026, 10, 20))
        self.assertIn("DTSTART;VALUE=DATE:20261116", text)
        self.assertIn("TRIGGER:-P14D", text)
        self.assertIn("테스트\\, 보고", text)
        self.assertNotIn("끝남", text)

    def test_committed_regulatory_json_is_consistent(self):
        reg = json.loads((ROOT / "hanwha" / "data" / "regulatory.json").read_text(encoding="utf-8"))
        ids = [t["id"] for t in reg["todo"]]
        self.assertEqual(len(ids), len(set(ids)))
        for t in reg["todo"]:
            self.assertIn(t["status"], ("done", "overdue", "upcoming", "check"))


if __name__ == "__main__":
    unittest.main()


class MarketsTest(unittest.TestCase):
    def setUp(self):
        import fetch_markets
        self.f = fetch_markets

    def test_perf_uses_last_close_on_or_before(self):
        p = [("2025-10-20", 100.0), ("2025-12-31", 110.0), ("2026-09-21", 120.0),
             ("2026-10-13", 125.0), ("2026-10-20", 130.0), ("2026-10-21", 131.0)]
        c = self.f.perf(p)["chg"]
        self.assertEqual(c["1D"], 0.77)
        self.assertEqual(c["1W"], 4.8)      # 10/14 이전 마지막 종가 125
        self.assertEqual(c["YTD"], 19.09)   # 전년 말 110
        self.assertEqual(c["1Y"], 31.0)

    def test_sbv_history_expands_monthly(self):
        import datetime as dt
        v = dict(self.f.monthly_from_changes(self.f.SBV_CHANGES, dt.date(2026, 10, 21)))
        self.assertEqual(v["2020-03"], 5.0)
        self.assertEqual(v["2026-10"], 4.5)


class RateCalendarTest(unittest.TestCase):
    def setUp(self):
        import build_rate_calendar
        self.c = build_rate_calendar

    def test_fed_decision_is_next_day_kst(self):
        page = "<h4>2026 FOMC Meetings</h4><div>October</div><div>27-28</div><div>December</div><div>8-9*</div><h4>2027 FOMC Meetings</h4><div>January</div><div>26-27</div>"
        got = self.c.parse_fed(page)
        self.assertIn((dt.date(2026, 10, 29), "10/27~28"), got)
        self.assertEqual(got[1][0], dt.date(2026, 12, 10))
        self.assertIn("SEP", got[1][1])
        self.assertEqual(got[2][0], dt.date(2027, 1, 28))

    def test_boj_and_boe_and_ecb(self):
        boj = "<h3>2026</h3><td>October 29 (Thu.), 30 (Fri.)</td><td>December 17 (Thu.), 18 (Fri.)</td>"
        self.assertEqual(self.c.parse_boj(boj)[0][0], dt.date(2026, 10, 30))
        boe = "<h2>2026</h2><td>Thursday 5 November</td><td>Thursday 17 December</td>"
        self.assertEqual([d for d, _ in self.c.parse_boe(boe)], [dt.date(2026, 11, 5), dt.date(2026, 12, 17)])
        ecb = "<dt>29/10/2026</dt><dd>Monetary policy meeting of the Governing Council, Day 2, followed by press conference</dd><dt>05/11/2026</dt><dd>Non-monetary policy meeting</dd>"
        self.assertEqual(self.c.parse_ecb(ecb), [(dt.date(2026, 10, 29), "")])

    def test_build_falls_back_and_marks_source(self):
        def fetch(url):
            if "federalreserve" in url:
                return "2026 FOMC Meetings October 27-28 December 8-9*"
            raise OSError("blocked")
        out = self.c.build(dt.date(2026, 10, 21), fetch)
        src = {k: v["source"] for k, v in out["banks"].items()}
        self.assertEqual(src["US"], "공식")
        self.assertEqual(src["KR"], "보조")
        self.assertEqual(src["CN"], "규칙")
        lpr = [e["date"] for e in out["events"] if e["bank"] == "CN"]
        self.assertIn("2026-12-21", lpr)  # 12/20 일요일 → 21일


class RateCalendarMergeTest(unittest.TestCase):
    def test_official_gaps_filled_from_fallback_and_duplicates_dropped(self):
        import build_rate_calendar as c

        def fetch(url):
            if "federalreserve" in url:
                return "2026 FOMC Meetings October 27-28 2027 FOMC Meetings January 25-26 January 26-27"
            if "bankofcanada" in url:
                return "October 28, 2026 Interest rate announcement"
            raise OSError("blocked")
        out = c.build(dt.date(2026, 10, 21), fetch)
        us = [e["date"] for e in out["events"] if e["bank"] == "US"]
        self.assertEqual(us.count("2027-01-27") + us.count("2027-01-28"), 1)
        ca = {e["date"]: e["source"] for e in out["events"] if e["bank"] == "CA"}
        self.assertEqual(ca, {"2026-10-28": "공식", "2026-12-09": "보조"})


class EntityLabelTest(unittest.TestCase):
    def test_page_data_names_entities_not_just_abbreviations(self):
        ents = json.loads((ROOT / "hanwha" / "data" / "entities.json").read_text(encoding="utf-8"))["entities"]
        self.assertEqual(sorted(e["key"] for e in ents), ["CAM", "CSA", "SG", "VN"])
        for e in ents:
            self.assertTrue(e["label"].endswith(f"({e['short']})") and len(e["label"]) > len(e["short"]) + 2, e["label"])


class PublicDataTest(unittest.TestCase):
    """공개 저장소에는 공시 자료와 사용자가 공개를 결정한 출자 이력만 둔다."""

    def test_internal_files_are_gone(self):
        for f in ("pl_view.json", "staff.json", "local_fs.json", "notes_3q26.json", "fx_periods.json"):
            self.assertFalse((ROOT / "hanwha" / "data" / f).exists(), f)

    def test_investment_history_has_no_bank_or_approval_fields(self):
        inv = json.loads((ROOT / "hanwha" / "data" / "investments.json").read_text(encoding="utf-8"))
        allowed = {"key", "type", "method", "report_date", "post_report", "remit_date", "ccy", "local_amt", "krw_mn", "stake_after"}
        for r in inv["rows"]:
            self.assertLessEqual(set(r), allowed)
        text = json.dumps(inv, ensure_ascii=False).lower()
        for word in ("swift", "계좌", "account", "기안", "memo", "비고"):
            self.assertNotIn(word, text)

    def test_report_date_formats(self):
        import build_investments as b
        self.assertEqual(b.report_date("19년3월27일"), ("2019-03-27", False))
        self.assertEqual(b.report_date("21년2월4일(사후보고)"), ("2021-02-04", True))
        self.assertEqual(b.report_date("2026년 03월 25일"), ("2026-03-25", False))
        self.assertEqual(b.report_date("-"), (None, False))

    def test_filed_reports_mark_periodic_items_done(self):
        reg = json.loads((ROOT / "hanwha" / "data" / "regulatory.json").read_text(encoding="utf-8"))
        self.assertFalse(any("GCM" in json.dumps(x, ensure_ascii=False) for x in reg["manual"] + reg["playbook"]))
        self.assertFalse(any("PTSV" in x.get("example", "") for x in reg["playbook"]))  # 당사 사례 대신 일반 예시만
        self.assertFalse(any(m.get("status") == "done" for m in reg["manual"]))  # 끝난 사건 항목은 남기지 않음
        self.assertEqual(build_deadlines.FILED_ID["9M"], "3Q")
