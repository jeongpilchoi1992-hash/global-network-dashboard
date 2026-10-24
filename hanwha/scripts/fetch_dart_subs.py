"""한화 탭의 해외자회사 숫자를 DART 공시로만 만든다 → hanwha/data/dart_subs.json.

- 실적·재무상태: 가장 최근 사업보고서와, 그 뒤에 나온 가장 최근 분기·반기보고서의 연결재무제표 주석
  '종속기업 요약재무정보'(자산·부채·영업수익·당기순이익, 백만원). 3분기보고서가 공시되면 다음 실행에서 자동으로 바뀐다.
- 지분율·출자: Open DART '타법인 출자현황'(최초취득일·최초취득금액·기초/증감/기말 장부가액·지분율, 백만원).
  타법인 출자현황에 없는 법인은 주석의 종속기업 지분율 표로 보완한다.
- 대외보고 일정용: 최근 정기보고서 접수 목록(filed). build_deadlines.py가 공시 항목 완료 여부를 여기서 읽는다.

GitHub Actions에서 env DART_API_KEY(secrets)로 실행한다(hanwha-markets.yml 평일 2회, update-data.yml 주간).
키가 없거나, 목록·원문 받기가 한 번이라도 실패하거나, 표를 못 찾으면 기존 숫자를 그대로 두고 접수 목록(filed)만 고친다
(일시 오류로 예전 기간으로 되돌아가지 않게). 출자현황은 직전 파일보다 새 보고서에서만 다시 받고, 실패하면 직전 값을 이어 쓴다.
표준 라이브러리만 쓰며 LLM을 쓰지 않는다.
"""
import datetime as dt
import html
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

# API 키: 환경변수(Actions Secrets) → 로컬 .env → 터미널 실행 시 숨김 입력(scripts/keys.py)
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from keys import get_key  # noqa: E402

API = "https://opendart.fss.or.kr/api"
CORP_CODE = "00148610"  # 한화투자증권
DATA = Path(__file__).resolve().parents[1] / "data"
OUT = DATA / "dart_subs.json"
NAMES = {  # 법인 키 -> 공시 표기에서 찾을 토큰
    "VN": [("pinetree", "vietnam"), ("pinetree securities corporation",), ("파인트리", "베트남")],
    "SG": [("pinetree", "pte"), ("pinetree", "singapore"), ("파인트리", "싱가포르")],
    "CSA": [("ciptadana", "sekuritas"), ("칩타다나", "증권"), ("찹타다나", "증권")],
    "CAM": [("ciptadana", "asset"), ("칩타다나", "자산운용"), ("찹타다나", "자산운용")],
}
ANY_NAME = ("pinetree", "ciptadana", "파인트리", "칩타다나", "찹타다나")
UNITS = {"백만원": 1, "천원": 1e-3, "원": 1e-6}


def get(path, **params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "gnd-hanwha/1.0"}), timeout=120) as r:
        return r.read()


MONTHS = {"1Q": 3, "1H": 6, "9M": 9, "FY": 12}
REPRT_CODE = {"1Q": "11013", "1H": "11012", "9M": "11014", "FY": "11011"}  # Open DART 정기보고서 코드


def periodic_reports(rows):
    """list.json 행 → 기간별 최신 접수 1건씩, 최신 기간 먼저. 정정보고서가 있으면 나중 접수본을 쓴다."""
    best = {}
    for r in rows:
        if not re.search(r"(분기|반기|사업)보고서", r.get("report_nm", "")):
            continue
        year, period = period_of(r["report_nm"])
        if not period:
            continue
        if (year, period) not in best or r["rcept_no"] > best[(year, period)]["rcept_no"]:
            best[(year, period)] = {**r, "year": year, "period": period}
    return sorted(best.values(), key=lambda r: (r["year"], MONTHS[r["period"]]), reverse=True)


def label_of(year, period):
    return f"FY{year}" if period == "FY" else f"{period}{year[2:]}"


def report_info(r):
    return {"name": re.sub(r"\s+", " ", r["report_nm"]).strip(), "rcept_no": r["rcept_no"], "rcept_dt": r["rcept_dt"],
            "url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={r['rcept_no']}", "year": r["year"], "period": r["period"]}


def period_of(report_nm):
    m = re.search(r"\((\d{4})\.(\d{2})\)", report_nm)
    if not m:
        return None, None
    year, month = m.group(1), m.group(2)
    return year, {"03": "1Q", "06": "1H", "09": "9M", "12": "FY"}.get(month)


def clean(cell):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", cell))).strip()


def tables(xml_text):
    """문서에서 (표 앞 텍스트, 행 목록)을 차례로 돌려준다. DART 문서는 TD/TH/TE/TU 셀을 섞어 쓴다."""
    for m in re.finditer(r"<TABLE\b.*?</TABLE>", xml_text, flags=re.S | re.I):
        before = clean(xml_text[max(0, m.start() - 600):m.start()])
        rows = []
        for tr in re.findall(r"<TR\b.*?</TR>", m.group(0), flags=re.S | re.I):
            cells = [clean(c) for c in re.findall(r"<(?:TD|TH|TE|TU)\b[^>]*>(.*?)</(?:TD|TH|TE|TU)>", tr, flags=re.S | re.I)]
            if any(cells):
                rows.append(cells)
        yield before, rows


def entity_of(name):
    low = name.lower()
    for k, alts in NAMES.items():
        if any(all(tok in low for tok in alt) for alt in alts):
            return k
    return None


def to_num(s):
    s = (s or "").replace(",", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")") or s.startswith("-") or s.startswith("△")
    s = s.strip("()-△")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def find_col(header, *needles):
    for i, h in enumerate(header):
        h2 = h.replace(" ", "")
        if any(n in h2 for n in needles):
            return i
    return None


def parse_summary(xml_texts):
    """종속기업 요약재무정보 표를 찾아 법인별 {자산, 부채, 영업수익, 당기순이익}(백만원)을 돌려준다."""
    found = []
    for text in xml_texts:
        for before, rows in tables(text):
            flat = " ".join(" ".join(r) for r in rows).lower()
            if not any(n in flat for n in ANY_NAME) or len(rows) < 2:
                continue
            hi = next((i for i, r in enumerate(rows[:4]) if find_col(r, "순이익", "순손익") is not None), None)
            if hi is None:
                continue
            header = rows[hi]
            unit = next((u for u in UNITS if re.search(r"단위\s*[:：]?\s*" + u, before + " " + " ".join(rows[0]))), "원")
            cols = {"assets": find_col(header, "자산"), "liab": find_col(header, "부채"),
                    "rev": find_col(header, "영업수익", "매출", "수익"), "ni": find_col(header, "당기순", "순이익", "순손익")}
            for r in rows[hi + 1:]:
                k = entity_of(r[0] if r else "")
                if not k:
                    continue
                # 머리글보다 셀이 적으면(병합 셀) 오른쪽 정렬로 맞춘다
                shift = len(header) - len(r)
                val = lambda c: None if c is None or c - shift < 1 or c - shift >= len(r) else to_num(r[c - shift])  # noqa: E731
                found.append({"key": k, "name": r[0], "unit": unit, "header": header, "row": r,
                              **{f: (None if val(c) is None else round(val(c) * UNITS[unit], 1)) for f, c in cols.items()}})
    # 같은 법인이 여러 표에 나오면 값이 가장 많이 채워진 행을 쓴다
    best = {}
    for f in found:
        score = sum(f[x] is not None for x in ("assets", "liab", "rev", "ni"))
        if score and (f["key"] not in best or score > best[f["key"]][0]):
            best[f["key"]] = (score, f)
    return {k: v[1] for k, v in best.items()}




def parse_stakes(xml_texts):
    """주석의 종속기업 현황 표에서 법인별 지분율(%)을 찾는다. 타법인 출자현황에 없는 법인(간접 보유 등) 보완용."""
    out = {}
    for text in xml_texts:
        for _, rows in tables(text):
            flat = " ".join(" ".join(r) for r in rows).lower()
            if not any(n in flat for n in ANY_NAME) or len(rows) < 2:
                continue
            hi = next((i for i, r in enumerate(rows[:3]) if find_col(r, "지분율", "소유지분") is not None), None)
            if hi is None:
                continue
            col = find_col(rows[hi], "지분율", "소유지분")
            for r in rows[hi + 1:]:
                k = entity_of(r[0] if r else "")
                if not k or k in out:
                    continue
                shift = len(rows[hi]) - len(r)
                c = col - max(shift, 0)
                v = to_num(r[c].replace("%", "")) if 0 < c < len(r) else None
                if v is not None and 0 < v <= 100:
                    out[k] = v
    return out


INVEST_FIELDS = {  # Open DART 타법인 출자현황 응답 필드 → 이 파일의 이름 (금액 백만원, 지분율 %)
    "frst_acqs_de": "first_date", "invstmnt_purps": "purpose", "frst_acqs_amount": "first_amount",
    "bsis_blce_qy": "begin_qty", "bsis_blce_qota_rt": "begin_stake", "bsis_blce_acntbk_amount": "begin_book",
    "incrs_dcrs_acqs_dsps_qy": "chg_qty", "incrs_dcrs_acqs_dsps_amount": "chg_amount", "incrs_dcrs_evl_lstmn": "chg_valuation",
    "trmend_blce_qy": "end_qty", "trmend_blce_qota_rt": "end_stake", "trmend_blce_acntbk_amount": "end_book",
    "recent_bsns_year_fnnr_sttus_tot_assets": "recent_assets", "recent_bsns_year_fnnr_sttus_thstrm_ntpf": "recent_ni",
}
TEXT_FIELDS = ("frst_acqs_de", "invstmnt_purps")
AMOUNTS = ("first_amount", "begin_book", "chg_amount", "chg_valuation", "end_book", "recent_assets", "recent_ni")


def invest_rows(api_list):
    """타법인 출자현황 응답 목록 → 해외자회사 4곳만 {키: 값}. 같은 법인이 여러 줄이면 기말 장부가액이 큰 줄.

    API 금액은 원 단위로 온다(한화투자증권 2026 반기: SG 총자산 5,078,000,000 = 요약재무 5,078백만원). 백만원으로 바꾼다.
    해외자회사 장부가가 1천만 원 미만일 수는 없으므로, 그보다 작으면 이미 백만원 단위로 보고 그대로 둔다.
    """
    out = {}
    for r in api_list or []:
        k = entity_of(r.get("inv_prm", ""))
        if not k:
            continue
        row = {"name": r.get("inv_prm", "").strip()}
        for f, name in INVEST_FIELDS.items():
            v = (r.get(f) or "").strip()
            row[name] = (v if v not in ("", "-") else None) if f in TEXT_FIELDS else to_num(v)
        if k not in out or (row["end_book"] or 0) > (out[k]["end_book"] or 0):
            out[k] = row
    big = max((abs(v[a]) for v in out.values() for a in ("end_book", "begin_book") if v[a]), default=0)
    if big >= 1e7:
        for v in out.values():
            for a in AMOUNTS:
                if v[a] is not None:
                    v[a] = round(v[a] / 1e6, 1)
    return out


def fetch_doc(key, rcept_no):
    """원문 텍스트 목록. 받기 실패(시간 초과, zip이 아닌 오류 응답)는 None으로 '표 없음'([])과 구분한다."""
    try:
        raw = get("document.xml", crtfc_key=key, rcept_no=rcept_no)
        z = zipfile.ZipFile(io.BytesIO(raw))
    except Exception as e:  # noqa: BLE001
        print(f"  원문 받기 실패 {rcept_no}: {e}")
        return None
    texts = []
    with z:
        for n in z.namelist():
            b = z.read(n)
            for enc in ("utf-8", "euc-kr", "cp949"):
                try:
                    texts.append(b.decode(enc))
                    break
                except UnicodeDecodeError:
                    continue
    return texts


def fetch_invest(key, rep):
    try:
        d = json.loads(get("otrCprInvstmntSttus.json", crtfc_key=key, corp_code=CORP_CODE,
                           bsns_year=rep["year"], reprt_code=REPRT_CODE[rep["period"]]))
    except Exception as e:  # noqa: BLE001
        print(f"  타법인 출자현황 실패 {rep['report_nm']}: {e}")
        return {}
    if d.get("status") != "000":
        print(f"  타법인 출자현황 {rep['report_nm']}: {d.get('status')} {d.get('message')}")
        return {}
    return invest_rows(d.get("list"))


def period_entry(rep, subs):
    return {"label": label_of(rep["year"], rep["period"]), "period": rep["period"], "year": rep["year"],
            "months": MONTHS[rep["period"]], "report": report_info(rep),
            "subs": {k: {**{f: v[f] for f in ("unit", "assets", "liab", "rev", "ni")}, "name": re.sub(r"\(주\d+\)", "", v["name"]).strip()}
                     for k, v in sorted(subs.items())}}


def main():
    key = get_key("DART_API_KEY")
    if not key:
        print("DART_API_KEY 없음: dart_subs.json 갱신 건너뜀")
        return 0
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    rows = json.loads(get("list.json", crtfc_key=key, corp_code=CORP_CODE, pblntf_ty="A", page_count=100,
                          bgn_de=(today - dt.timedelta(days=550)).strftime("%Y%m%d"), end_de=today.strftime("%Y%m%d")))
    if rows.get("status") != "000":  # 요청 한도·점검·키 오류: 아무것도 바꾸지 않는다
        print(f"공시 목록 받기 실패 {rows.get('status')} {rows.get('message')} (기존 파일 유지)")
        return 0
    reps = periodic_reports(rows.get("list", []))
    filed = [{"year": r["year"], "period": r["period"], "name": r["report_nm"].strip(), "rcept_dt": r["rcept_dt"]} for r in reps]
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    order = lambda r: (int(r["year"]), MONTHS[r["period"]])  # noqa: E731
    annual = next((r for r in reps if r["period"] == "FY"), None)
    # 사업보고서 1건 + 그 뒤 분기·반기보고서 중 요약재무정보가 있는 가장 최근 1건
    chosen, docs, failed = [], {}, False
    for r in ([annual] if annual else []) + [r for r in reps if r["period"] != "FY" and not (annual and order(r) <= order(annual))]:
        docs[r["rcept_no"]] = fetch_doc(key, r["rcept_no"])
        if docs[r["rcept_no"]] is None:
            failed = True
            break
        subs = parse_summary(docs[r["rcept_no"]])
        print(f"  {r['report_nm'].strip()}: 요약재무정보 {', '.join(sorted(subs)) or '없음'}")
        if subs:
            chosen.append((r, subs))
            if r is not annual:
                break
    if failed or not chosen:
        print("원문 받기 실패 또는 요약재무정보 표 없음 (숫자는 기존 파일 유지, 접수 목록만 갱신)")
        if prev and prev.get("filed") != filed:
            OUT.write_text(json.dumps({**prev, "filed": filed}, ensure_ascii=False, indent=1), encoding="utf-8")
        return 0
    chosen.sort(key=lambda x: order(x[0]))
    # 지분율·출자: 최신 보고서부터 내려가되 직전 파일의 출자현황 보고서보다 오래된 것은 받지 않는다 → 주석 지분율 표 → 직전 파일 값
    pr = (prev.get("invest") or {}).get("report") or {}
    floor = (int(pr["year"]), MONTHS[pr["period"]], pr.get("rcept_no", "")) if pr.get("year") and pr.get("period") in MONTHS else None
    invest, invest_rep = {}, None
    for rep in (r for r in reps if order(r) <= order(chosen[-1][0])):
        if floor and (*order(rep), rep["rcept_no"]) < floor:
            break
        invest = fetch_invest(key, rep)
        if invest:
            invest_rep = rep
            break
    if not invest and (prev.get("invest") or {}).get("rows"):
        print("  새 타법인 출자현황 없음: 직전 파일 값 유지")
        invest = prev["invest"]["rows"]
    stakes = {k: v["end_stake"] for k, v in invest.items() if v.get("end_stake")}
    source = {k: "타법인 출자현황" for k in stakes}
    for rep, _ in reversed(chosen):
        for k, v in parse_stakes(docs[rep["rcept_no"]]).items():
            if k not in stakes:
                stakes[k], source[k] = v, f"연결재무제표 주석 ({label_of(rep['year'], rep['period'])})"
    for k, v in (prev.get("stakes") or {}).items():
        if k not in stakes:
            stakes[k], source[k] = v, (prev.get("stake_source") or {}).get(k, "직전 수집값")
    out = {"updated": today.isoformat(),
           "source": "DART 정기보고서: 연결재무제표 주석 '종속기업 요약재무정보', '타법인 출자현황'",
           "periods": [period_entry(rep, subs) for rep, subs in chosen],
           "stakes": stakes, "stake_source": source,
           "invest": ({"report": report_info(invest_rep), "unit": "백만원, 주, %", "rows": invest} if invest_rep
                      else prev.get("invest") if invest else None),
           "filed": filed}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for p in out["periods"]:
        print(f"{p['label']} {p['report']['name']}: " + " · ".join(f"{k} 자산 {v['assets']} 부채 {v['liab']} 수익 {v['rev']} 순이익 {v['ni']}" for k, v in p["subs"].items()))
    print("지분율", stakes, source)
    print("출자", invest_rep and invest_rep["report_nm"], json.dumps(invest, ensure_ascii=False))
    print(f"saved {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
