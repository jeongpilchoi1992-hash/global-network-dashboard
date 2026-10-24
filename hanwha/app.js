// 한화투자증권 글로벌네트워크 현황: data/*.json을 읽어 네 탭을 그린다. 빌드 도구 없이 정적 호스팅.
// 숫자는 DART 공시(dart_subs.json)만 쓴다. 출자 이력(investments.json)만 내부 출자내역을 손으로 옮긴 값이다.
const $ = (s) => document.querySelector(s);

const fmt = (v) => (v == null ? "–" : (v < 0 ? `(${Math.abs(v).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`
  : v.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })));
const eok = (v) => (v == null ? "–" : `${(v / 100).toFixed(1)}억원`);
const pct = (v) => (v == null ? "-" : `${(v * 100).toFixed(0)}%`);
const cls = (v) => (v == null ? "" : v < 0 ? "neg" : "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// 법인 표시명: "베트남 법인(PTSV)" (entities.json). label이 없으면 약어
const lab = (e) => esc(e.label || e.short);
// 표마다 오른쪽 위에 붙이는 한 줄: 기준 시점 · 단위
const tm = (basis, unit) => `<div class="tmeta">${basis ? `기준 ${esc(basis)}` : ""}${basis && unit ? " · " : ""}${unit ? `단위: ${esc(unit)}` : ""}</div>`;

async function load(name) {
  try {
    const r = await fetch(`data/${name}`, { cache: "no-store" });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// 대시보드 셸의 iframe 안에서 열리면 제목을 숨기고 높이를 내용에 맞춘다
const embedded = window.self !== window.top;
function fit() {
  if (!embedded) return;
  try { window.frameElement.style.height = `${document.documentElement.scrollHeight + 20}px`; } catch {}
}

function tabs() {
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav button, section").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $(`#${b.dataset.tab}`).classList.add("on");
    fit();
    try { localStorage.setItem("hanwha-tab", b.dataset.tab); } catch {}
  }));
  try {
    const t = localStorage.getItem("hanwha-tab");
    if (t) document.querySelector(`nav button[data-tab="${t}"]`)?.click();
  } catch {}
}

// ---------- 공시 모델: dart_subs.json(DART) + entities.json(기준 정보) ----------
// periods는 오래된 것 → 최신 순. 최신 = 가장 최근 분기·반기·사업보고서, FY = 가장 최근 사업보고서
function model(D, ents) {
  const P = D.periods || [];
  // 최신이 사업보고서뿐이면 FY 열을 따로 두지 않는다
  const L = P.at(-1), F = [...P].reverse().find((p) => p.period === "FY" && p !== L);
  const stake = (k) => (D.stakes?.[k] ?? 100) / 100;
  const row = (p, k) => {
    const x = p?.subs?.[k];
    if (!x) return null;
    const eq = x.assets != null && x.liab != null ? x.assets - x.liab : null;
    return { ...x, eq, roe: x.ni != null && eq ? (x.ni * (12 / p.months)) / eq : null };
  };
  const E = ents.map((e) => ({ ...e, stake: stake(e.key), l: row(L, e.key), f: row(F, e.key), inv: D.invest?.rows?.[e.key] || null }));
  const sum = (side, m, w) => {
    const xs = E.map((e) => [e[side]?.[m], w ? e.stake : 1]).filter(([v]) => v != null);
    return xs.length ? xs.reduce((a, [v, s]) => a + v * s, 0) : null;
  };
  const roe = (side, p) => {
    const xs = E.filter((e) => e[side]?.ni != null && e[side]?.eq);
    const eq = xs.reduce((a, e) => a + e[side].eq, 0);
    return eq ? (xs.reduce((a, e) => a + e[side].ni, 0) * (12 / p.months)) / eq : null;
  };
  // 증감·비율 합계는 두 값이 모두 있는 법인끼리만 더한다(한쪽에만 있는 법인이 섞이지 않게)
  const both = (fa, fb) => {
    const xs = E.filter((e) => fa(e) != null && fb(e) != null);
    return xs.length ? [xs.reduce((a, e) => a + fa(e), 0), xs.reduce((a, e) => a + fb(e), 0)] : null;
  };
  return { L, F, E, sum, roe, both };
}
const ymd = (s) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "");
const pct1 = (v) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
// 순이익 막대: 0을 가운데 두고 음수는 왼쪽(빨강), 양수는 오른쪽(초록)
const dbar = (v, max) => {
  if (v == null) return `<div class="dv"><b></b></div>`;
  const w = max ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return `<div class="dv" title="${fmt(v)}"><i class="${v < 0 ? "n" : "p"}" style="width:${w}%"></i><b></b></div>`;
};

function renderPL(D, ents, reg) {
  const { L, F, E, sum, roe, both } = model(D, ents);
  const ctrlL = sum("l", "ni", true), ctrlF = sum("f", "ni", true);
  const prof = E.filter((e) => (e.l?.ni ?? 0) > 0);
  // FY 손익이 없는 법인: 재무상태만 있으면 그해 말 취득, 행 자체가 없으면 공시에서 빠진 것
  const acq = F ? E.filter((e) => e.f && e.f.ni == null) : [], gone = F ? E.filter((e) => !e.f) : [];
  const noF = [...acq, ...gone];
  const noFtxt = [acq.length ? `${acq.map(lab).join(", ")} 손익 미포함 (취득 시점)` : "", gone.length ? `${gone.map(lab).join(", ")} 공시에 없음` : ""].filter(Boolean).join(" · ");
  const kpis = [
    [`${L.label} 영업수익 (4사 합산)`, eok(sum("l", "rev")), F ? `${F.label} ${eok(sum("f", "rev"))}` : ""],
    [`${L.label} 지배지분 순이익`, eok(ctrlL), `100% 기준 ${eok(sum("l", "ni"))}`, ctrlL],
    [`${L.label} ${L.months === 12 ? "" : "연환산 "}ROE (4사)`, pct1(roe("l", L)), F ? `${F.label} ${pct1(roe("f", F))} · 기말 자본 기준` : "", roe("l", L)],
    F && [`${F.label} 지배지분 순이익`, eok(ctrlF), noF.length ? noFtxt : `100% 기준 ${eok(sum("f", "ni"))}`, ctrlF],
    [`${L.label} 흑자 법인`, `${prof.length} / ${E.length}`, prof.map(lab).join(", ") || "없음"],
  ].filter(Boolean);
  let h = `<div class="grid kpis">${kpis.map(([l, v, s, n]) => `<div class="card kpi"><div class="l">${l}</div><div class="v ${n == null ? "" : n < 0 ? "neg" : ""}">${v}</div><div class="sub">${s || ""}</div></div>`).join("")}</div>`;
  h += `<div class="sub">DART 정기보고서 연결재무제표 주석 「종속기업 요약재무정보」(법인 단위, 연결 조정 전) · 지분율은 「타법인 출자현황」 · 내부 계획·현지 결산은 쓰지 않습니다.</div>`;

  // 법인별 실적
  const mx = Math.max(...E.map((e) => Math.abs(e.l?.ni ?? 0)), 1);
  const lm = `${L.months}개월`;
  h += `<h2>법인별 실적 (DART 공시)</h2><div class="card wrap">${tm(`${F ? `${F.label} ${F.report.name} · ` : ""}${L.label} ${L.report.name}`, "백만원, ROE %")}
    <table class="mt"><thead><tr><th rowspan="2">법인 (지분율)</th>${F ? `<th colspan="3" class="c">${F.label} (12개월)</th>` : ""}<th colspan="4" class="c">${L.label} (${lm} 누적)</th><th rowspan="2" style="min-width:150px">${L.label} 순이익 <span class="sub">(−　0　+)</span></th></tr>
    <tr>${F ? "<th>영업수익</th><th>순이익</th><th>ROE</th>" : ""}<th>영업수익</th><th>순이익</th><th>지배지분 순이익</th><th>ROE${L.months === 12 ? "" : " (연환산)"}</th></tr></thead><tbody>`;
  for (const e of E) {
    const f = e.f || {}, l = e.l || {};
    const na = !e.f ? "공시 없음" : f.ni == null ? "취득 전·손익 미연결" : "";
    h += `<tr><td><b>${lab(e)}</b> <span class="sub">${(e.stake * 100).toFixed(e.stake < 1 && e.stake > 0.999 ? 2 : 0)}%</span></td>
      ${F ? `<td title="${na}">${fmt(f.rev)}</td><td class="${cls(f.ni)}" title="${na}">${fmt(f.ni)}</td><td class="${cls(f.roe)}">${pct1(f.roe)}</td>` : ""}
      <td>${fmt(l.rev)}</td><td class="${cls(l.ni)}">${fmt(l.ni)}</td><td class="${cls(l.ni)}">${l.ni == null ? "–" : fmt(l.ni * e.stake)}</td><td class="${cls(l.roe)}">${pct1(l.roe)}</td>
      <td>${dbar(l.ni, mx)}</td></tr>`;
  }
  h += `<tr class="tot"><td><b>4사 합산 (100%)</b></td>${F ? `<td>${fmt(sum("f", "rev"))}</td><td class="${cls(sum("f", "ni"))}">${fmt(sum("f", "ni"))}</td><td>${pct1(roe("f", F))}</td>` : ""}
    <td>${fmt(sum("l", "rev"))}</td><td class="${cls(sum("l", "ni"))}">${fmt(sum("l", "ni"))}</td><td class="${cls(ctrlL)}"><b>${fmt(ctrlL)}</b></td><td>${pct1(roe("l", L))}</td><td></td></tr>`;
  h += `</tbody></table></div><div class="sub">ROE = 누적 순이익 × (12 ÷ 개월 수) ÷ 기말 자본(자산 − 부채)${L.months !== 12 ? `, ${L.label}은 × ${Number.isInteger(12 / L.months) ? 12 / L.months : `12/${L.months}`}` : ""}. 지배지분 순이익 = 순이익 × 지분율. ${acq.length ? `${acq.map(lab).join(", ")}은 ${F.label} 말 취득이라 사업보고서에 재무상태만 있고 손익은 없습니다.` : ""}${gone.length ? ` ${gone.map(lab).join(", ")}은 ${F.label} 요약재무정보에 없습니다.` : ""}</div>`;

  // 재무상태
  h += `<h2>재무상태 (DART 공시)</h2><div class="card wrap">${tm(`${F ? `${F.label} 말 · ` : ""}${L.label} 말`, "백만원")}<table class="mt"><thead><tr><th rowspan="2">법인</th>${F ? `<th colspan="3" class="c">${F.label} 말</th>` : ""}<th colspan="3" class="c">${L.label} 말</th>${F ? "<th rowspan=\"2\">자본 증감</th>" : ""}</tr>
    <tr>${(F ? ["자산", "부채", "자본"] : []).concat(["자산", "부채", "자본"]).map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>`;
  const bs = (r) => [r?.assets, r?.liab, r?.eq].map((v) => `<td class="${cls(v)}">${fmt(v)}</td>`).join("");
  for (const e of E) {
    const d = e.l?.eq != null && e.f?.eq != null ? e.l.eq - e.f.eq : null;
    h += `<tr><td><b>${lab(e)}</b></td>${F ? bs(e.f) : ""}${bs(e.l)}${F ? `<td class="${cls(d)}">${d == null ? "–" : `${d > 0 ? "+" : ""}${fmt(d)}`}</td>` : ""}</tr>`;
  }
  const tot = (side) => ["assets", "liab", "eq"].map((m) => `<td>${fmt(sum(side, m))}</td>`).join("");
  const dd = both((e) => e.l?.eq, (e) => e.f?.eq), dT = dd ? dd[0] - dd[1] : null;
  h += `<tr class="tot"><td><b>4사 합산</b></td>${F ? tot("f") : ""}${tot("l")}${F ? `<td class="${cls(dT)}">${dT == null ? "–" : `${dT > 0 ? "+" : ""}${fmt(dT)}`}</td>` : ""}</tr></tbody></table></div>`;

  // 법인별 주력 사업과 특이사항: entities.json의 공개 정보 문장만 쓴다(내부 재무·분석은 넣지 않는다)
  if (E.some((e) => e.focus || e.notes?.length)) {
    h += `<h2>법인별 주력 사업과 특이사항</h2><div class="grid cards">${E.map((e) => `<div class="card"><h3>${esc(e.label)}</h3><div class="biz">${esc(e.focus || e.biz || "")}</div>
      ${e.notes?.length ? `<ul class="notes">${e.notes.map(([t, x]) => `<li><b>[${esc(t)}]</b> ${esc(x)}</li>`).join("")}</ul>` : ""}</div>`).join("")}</div>`;
  }

  // 출처와 자동 갱신
  const next = (reg?.todo || []).filter((t) => t.id.startsWith("periodic-") && t.status !== "done" && t.due).sort((a, b) => a.due.localeCompare(b.due))[0];
  const nextName = next ? next.item.replace(" 해외자회사·타법인출자현황 반영", "") : "";
  h += `<h2>출처와 자동 갱신</h2><div class="grid two">
    <div class="card"><b>공시 원문</b><ul class="notes">${(D.periods || []).map((p) => `<li><b>${esc(p.label)}</b> <a href="${esc(p.report.url)}" target="_blank" rel="noopener">${esc(p.report.name)}</a> <span class="sub">접수 ${ymd(p.report.rcept_dt)}</span></li>`).join("")}
      ${D.invest ? `<li><b>출자</b> <a href="${esc(D.invest.report.url)}" target="_blank" rel="noopener">${esc(D.invest.report.name)}</a> 타법인 출자현황 <span class="sub">접수 ${ymd(D.invest.report.rcept_dt)}</span></li>` : ""}</ul></div>
    <div class="card"><b>자동 갱신 (평일 07:30·16:30, 토큰 없음)</b><ul class="notes">
      <li><b>다음 공시</b> ${next ? `${esc(nextName)} (제출 기한 ${esc(next.due)})가 DART에 올라오면 다음 확인 때 ${esc(L.label)} → 새 기간으로 바뀌고 ROE 연환산 배수도 따라 바뀝니다.` : "다음 정기보고서가 올라오면 자동으로 바뀝니다."}</li>
      <li><b>사업보고서</b> FY 열은 가장 최근 사업보고서(매년 3월 공시)로 바뀝니다. 엑셀·1장 보고서도 공시 기준이 바뀐 날 다시 만듭니다.</li>
      <li><b>공개 범위</b> 공시 자료만 씁니다. 사업부문별 손익·계획 대비·현지 결산은 공시되지 않아 넣지 않습니다.</li></ul></div></div>`;
  h += `<h2>다운로드</h2><div class="dl" id="dl"></div>`;
  $("#pl").innerHTML = h;
  document.querySelector('nav button[data-tab="pl"]').textContent = `해외자회사 실적 (${L.label} 공시)`;
  // 다운로드 파일은 저장소에 있을 때만 버튼을 보여 주고, 기준 기간은 파일을 만든 기준(basis.json)에서 읽는다
  const files = [["downloads/해외자회사_공시실적.xlsx", "엑셀 (공시 실적)"], ["downloads/해외자회사_공시실적_1장보고서.docx", "1장 보고서 (Word)"], ["downloads/해외자회사_공시실적_1장보고서.pdf", "1장 보고서 (PDF)"]];
  const basis = fetch("downloads/basis.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([basis, ...files.map(([f]) => fetch(f, { method: "HEAD" }).then((r) => r.ok).catch(() => false))]).then(([b, ...ok]) => {
    const shown = files.filter((_, i) => ok[i]);
    const same = b && (b.periods || []).join() === (D.periods || []).map((p) => p.report.rcept_no).join();
    const note = same ? `${esc(L.label)} 공시 기준` : b?.label ? `${esc(b.label)} 공시 기준 · 화면(${esc(L.label)})과 기간이 달라 다음 자동 갱신 때 맞춰집니다` : "공시 기준 · 다음 자동 갱신 때 화면과 맞춰집니다";
    $("#dl").innerHTML = shown.length ? shown.map(([f, l]) => `<a href="${encodeURI(f)}" download>${l}</a>`).join("") + `<span class="sub"> ${note}</span>`
      : `<span class="sub">엑셀·1장 보고서는 다음 자동 갱신 때 만들어집니다.</span>`;
  });
}

function renderEnt(D, ents, inv) {
  const { L, E, sum, both } = model(D, ents);
  const ir = D.invest;
  const dt = (s) => (s ? s.replace(/\./g, "-") : "–");
  const nav = (e) => (e.l?.eq != null ? e.l.eq * e.stake : null);
  let h = `<h2>해외법인 현황</h2><div class="card wrap">${tm(`재무 ${L.label} 말${ir ? ` · 지분율·장부가 ${ir.report.name} 타법인 출자현황` : ""}`, "백만원, %")}<table class="mt"><thead><tr>
    <th>법인</th><th class="l">국가·도시</th><th class="l">통화</th><th class="l">영위업무</th><th>지분율</th><th>자본총계</th><th>지분 순자산</th><th>장부가액</th><th>순자산/장부가</th></tr></thead><tbody>`;
  for (const e of E) {
    const n = nav(e), bk = e.inv?.end_book, r = n != null && bk ? n / bk : null;
    h += `<tr><td><b>${lab(e)}</b><div class="sub">${esc(e.name)}</div></td><td class="l">${esc(e.country)} <span class="sub">${esc(e.city)}</span></td><td class="l">${e.ccy}</td><td class="l">${esc(e.biz)}</td>
      <td>${(e.stake * 100).toFixed(2)}%</td><td>${fmt(e.l?.eq)}</td><td>${fmt(n)}</td><td>${fmt(bk)}</td><td class="${r != null && r < 0.5 ? "neg" : ""}">${r == null ? "–" : pct(r)}</td></tr>`;
  }
  const bks = E.map((e) => e.inv?.end_book).filter((v) => v != null), sB = bks.length ? bks.reduce((a, v) => a + v, 0) : null;
  const nb = both(nav, (e) => e.inv?.end_book); // 순자산/장부가 합계는 둘 다 있는 법인끼리
  h += `<tr class="tot"><td><b>4사 합계</b></td><td colspan="4"></td><td>${fmt(sum("l", "eq"))}</td><td>${fmt(sum("l", "eq", true))}</td><td>${fmt(sB)}</td><td>${nb && nb[1] ? pct(nb[0] / nb[1]) : "–"}</td></tr>`;
  h += `</tbody></table></div><div class="sub">지분 순자산 = ${esc(L.label)} 말 자본총계 × 지분율. 장부가액은 당사 별도 재무제표상 기말 장부가(타법인 출자현황). 50% 미만은 빨간색.</div>`;

  if (ir) {
    h += `<h2>출자 현황 (DART 타법인 출자현황)</h2><div class="card wrap">${tm(`${ir.report.name} (접수 ${ymd(ir.report.rcept_dt)})`, "백만원, 주, %")}<table class="mt"><thead>
      <tr><th rowspan="2">법인</th><th rowspan="2" class="l">출자목적</th><th colspan="2" class="c">최초 취득</th><th colspan="3" class="c">기초 잔액</th><th colspan="3" class="c">증가(감소)</th><th colspan="3" class="c">기말 잔액</th><th colspan="2" class="c">최근 사업연도</th></tr>
      <tr><th>일자</th><th>금액</th><th>수량</th><th>지분율</th><th>장부가</th><th>수량</th><th>취득(처분)</th><th>평가손익</th><th>수량</th><th>지분율</th><th>장부가</th><th>총자산</th><th>당기순손익</th></tr></thead><tbody>`;
    const q = (v) => (v == null ? "–" : v.toLocaleString("ko-KR"));
    const r1 = (v) => (v == null ? "–" : `${v.toFixed(2)}`);
    for (const e of E) {
      const x = e.inv;
      if (!x) { h += `<tr><td><b>${lab(e)}</b></td><td colspan="14" class="sub" style="text-align:left">타법인 출자현황에 없음</td></tr>`; continue; }
      h += `<tr><td><b>${lab(e)}</b></td><td class="l">${esc(x.purpose || "–")}</td><td>${dt(x.first_date)}</td><td>${fmt(x.first_amount)}</td>
        <td>${q(x.begin_qty)}</td><td>${r1(x.begin_stake)}</td><td>${fmt(x.begin_book)}</td><td>${q(x.chg_qty)}</td><td>${fmt(x.chg_amount)}</td><td>${fmt(x.chg_valuation)}</td>
        <td>${q(x.end_qty)}</td><td>${r1(x.end_stake)}</td><td><b>${fmt(x.end_book)}</b></td><td>${fmt(x.recent_assets)}</td><td class="${cls(x.recent_ni)}">${fmt(x.recent_ni)}</td></tr>`;
    }
    h += `</tbody></table></div><div class="sub">DART 원문 표 구성을 그대로 따릅니다. '최근 사업연도'는 직전 사업연도 말 피투자회사 재무(${esc(ir.report.year - (ir.report.period === "FY" ? 0 : 1))}년)입니다.</div>`;
  }

  // 출자 이력: 회차별 송금일·현지통화 금액은 공시에 없어 내부 출자내역(수동)
  const R = inv?.rows || [];
  if (R.length) {
    h += `<h2>출자 이력 <span class="chip warn">내부 출자내역 기준(수동)</span></h2><div class="card wrap">${tm(`해외자회사 출자내역 (${esc(inv.updated || "")} 반영, 출자 시 수동 갱신)`, "현지통화, 원화 백만원, %")}<table class="mt"><thead><tr>
      <th>법인</th><th class="l">구분</th><th class="l">취득방법</th><th>해외직접투자 신고일</th><th>송금일</th><th class="l">통화</th><th>현지통화 금액</th><th>원화 취득원가</th><th>투자 후 지분율</th></tr></thead><tbody>`;
    for (const e of E) {
      const xs = R.filter((x) => x.key === e.key);
      if (!xs.length) continue;
      for (const x of xs) {
        h += `<tr><td>${lab(e)}</td><td class="l">${esc(x.type)}</td><td class="l">${esc(x.method || "")}</td><td>${x.report_date || "–"}${x.post_report ? ` <span class="chip">사후보고</span>` : ""}</td><td>${x.remit_date || "–"}</td>
          <td class="l">${x.ccy}</td><td>${x.local_amt ? x.local_amt.toLocaleString("en-US") : "–"}</td><td>${x.krw_mn ? fmt(x.krw_mn) : "–"}</td><td>${x.stake_after == null ? "–" : `${(x.stake_after * 100).toFixed(2)}%`}</td></tr>`;
      }
      const cum = xs.reduce((a, x) => a + (x.krw_mn || 0), 0), bk = e.inv?.end_book;
      h += `<tr class="tot"><td colspan="7" class="sub" style="text-align:left">${lab(e)} 누적 원화 취득원가${bk ? ` · DART 기말 장부가 ${fmt(bk)} (차이 ${fmt(bk - cum)})` : ""}</td><td><b>${fmt(cum)}</b></td><td></td></tr>`;
    }
    h += `</tbody></table></div><div class="sub">회차별 송금일·현지통화 금액은 공시에 없어 내부 출자내역을 손으로 옮깁니다. 증자·인수가 있으면 출자내역 엑셀을 고친 뒤 <code>python hanwha/scripts/build_investments.py</code>로 다시 만듭니다. 장부가와의 차이는 환율·부대비용·손상 등입니다.</div>`;
  }
  $("#ent").innerHTML = h;
}

function renderReg(r) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const dday = (s) => (s ? Math.round((new Date(s) - today) / 864e5) : null);
  const open = r.todo.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.due && dday(t.due) < 0);
  const soon = open.filter((t) => t.due && dday(t.due) >= 0 && dday(t.due) <= 30);
  const next = open.filter((t) => t.due && dday(t.due) >= 0).sort((a, b) => a.due.localeCompare(b.due))[0];
  const ext = open.filter((t) => t.law !== "내부");
  const kpis = [
    ["기한 경과", `${overdue.length}건`, overdue.length ? overdue.map((t) => t.item).join(", ") : "누락 없음", overdue.length ? "neg" : "pos"],
    ["30일 이내 마감", `${soon.length}건`, soon.map((t) => `${t.due.slice(5)} ${t.item}`).join(" · ") || "-", soon.length ? "warn" : ""],
    ["다음 마감", next ? `D-${dday(next.due)}` : "-", next ? `${next.due} ${next.entity} ${next.item}` : "", ""],
    ["12개월 안 대외보고", `${ext.length}건`, `내부 일정 ${open.length - ext.length}건 별도 · 기한 미정 ${open.filter((t) => !t.due).length}건`, ""],
  ];
  const chipOf = (t) => {
    const dd = dday(t.due);
    return t.status === "done" ? `<span class="chip ok">완료</span>`
      : dd != null && dd < 0 ? `<span class="chip bad">기한 경과 D+${-dd}</span>`
      : t.status === "check" ? `<span class="chip warn">진행 중</span>`
      : dd != null && dd <= 7 ? `<span class="chip bad">D-${dd}</span>`
      : dd != null && dd <= 30 ? `<span class="chip warn">D-${dd}</span>`
      : `<span class="chip">${dd != null ? `D-${dd}` : "기한 미정"}</span>`;
  };
  let h = `<div class="grid kpis">${kpis.map(([l, v, s, c]) => `<div class="card kpi"><div class="l">${l}</div><div class="v ${c === "neg" ? "neg" : c === "pos" ? "pos" : ""}">${v}</div><div class="sub">${esc(s)}</div></div>`).join("")}</div>`;

  // 왼쪽: 월별 마감 일정, 오른쪽: 알림 받는 법과 이벤트별 체크리스트
  const months = {};
  for (const t of [...r.todo].sort((a, b) => (a.due || "9").localeCompare(b.due || "9"))) (months[t.due ? t.due.slice(0, 7) : "기한 미정 (사건 발생 시)"] ||= []).push(t);
  h += `<div class="grid two"><div><h2>12개월 마감 일정 <span class="sub">(기한은 스크립트가 법정 기준으로 자동 계산, ${esc(r.generated || r.updated)})</span></h2><div class="card tl">`;
  for (const [m, list] of Object.entries(months)) {
    h += `<div class="mon">${esc(m)}</div>` + list.map((t) => `<div class="ev ${t.status === "done" ? "done" : ""}"><div>${chipOf(t)}</div><div><b>${esc(t.item)}</b> <span class="tag ${t.law === "내부" ? "" : "ext"}">${esc(t.law)}</span>
      <div class="sub">${[t.entity, t.due, t.basis, t.note].filter(Boolean).map(esc).join(" · ")}</div></div></div>`).join("");
  }
  h += `</div></div><div><h2>놓치지 않게: 알림</h2><div class="card alerts">
    <p><b>① 일정 구독</b> 아래 주소를 Outlook·Google 캘린더에 <i>인터넷 일정 추가</i>로 넣으면 각 마감 14일·3일 전에 알림이 옵니다. 매주 자동으로 다시 계산됩니다.</p>
    <div class="dl"><a href="downloads/hanwha_regulatory.ics" download>캘린더 파일 (.ics)</a> <button id="icscopy" class="ghost">구독 주소 복사</button></div>
    <p><b>② 주간 알림 이슈</b> 매주 월요일 08:30 GitHub Actions가 30일 이내·기한 경과 항목을 GitHub 이슈로 올리고 담당자에게 메일을 보냅니다.</p>
    <p><b>③ 완료 처리</b> 제출하면 <code>data/regulatory.json</code>의 <code>done_ids</code>에 항목 ID를 추가합니다. 완료되지 않은 항목은 기한이 지나는 순간 빨간색으로 바뀝니다.</p></div>
    <h2>이런 일이 생기면 <span class="sub">(사건별 보고 순서)</span></h2>`;
  h += (r.playbook || []).map((p, i) => `<details class="card pb"${i === 0 ? " open" : ""}><summary><b>${esc(p.event)}</b> <span class="sub">${esc(p.example || "")} · ${p.steps.length}단계</span></summary>
    <ol>${p.steps.map(([when, rep, basis, note]) => `<li><span class="when">${esc(when)}</span> <b>${esc(rep)}</b><div class="sub">${esc(basis)}${note ? ` · ${esc(note)}` : ""}</div></li>`).join("")}</ol></details>`).join("");
  h += `</div></div>`;

  const laws = [...new Set(r.rules.map((x) => x.law))];
  h += `<h2>사유별 대외보고 한눈에 보기</h2><div class="filters" id="lawf"><button class="on" data-law="">전체</button>${laws.map((l) => `<button data-law="${esc(l)}">${esc(l)}</button>`).join("")}</div>
    <div class="card wrap">${tm(`현행 법령·규정 (${r.updated || r.generated || ""} 확인)`, "")}<table class="reg"><thead><tr><th>사유 (언제)</th><th>보고서·별지</th><th>제출처</th><th>기한</th><th>근거</th><th>첨부·비고</th></tr></thead><tbody id="rules"></tbody></table></div>
    <div class="banner" style="margin-top:12px">${esc(r.disclaimer)}</div>`;
  $("#reg").innerHTML = h;
  document.querySelectorAll("#reg details").forEach((d) => d.addEventListener("toggle", fit));
  $("#icscopy")?.addEventListener("click", (e) => {
    const u = new URL("downloads/hanwha_regulatory.ics", location.href).href;
    navigator.clipboard?.writeText(u).then(() => (e.target.textContent = "복사됨"), () => (e.target.textContent = u));
  });
  const draw = (law) => {
    $("#rules").innerHTML = r.rules.filter((x) => !law || x.law === law).map((x) =>
      `<tr><td>${esc(x.event)}</td><td><b>${esc(x.report)}</b></td><td>${esc(x.to)}</td><td>${esc(x.deadline)}</td><td>${esc(x.basis)}</td><td class="sub">${esc(x.attach)}</td></tr>`).join("");
  };
  draw("");
  document.querySelectorAll("#lawf button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#lawf button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); draw(b.dataset.law); fit();
  }));
}

// YTD Macro 탭: markets.json(평일 하루 2회 자동 수집)과 rate_calendar.json(연 1회 수동)으로 그린다
const SERIES_COLOR = { US: "#4c8dff", KR: "#ff7b4a", EU: "#2bb58a", JP: "#e8a72e", UK: "#e7a6b8", ID: "#2f9e44", VN: "#8b6cf0", CN: "#ff9aa2", IN: "#36b7c9", CA: "#c0c7d6" };
const heat = (v, scale) => {
  if (v == null) return "";
  const a = Math.min(Math.abs(v) / scale, 1) * 0.5 + 0.05;
  return `background:${v >= 0 ? `rgba(255,107,94,${a.toFixed(2)})` : `rgba(110,150,255,${a.toFixed(2)})`}`;
};
const sgn = (v, d = 2) => (v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const num = (v, d = 2) => (v == null ? "-" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

function spark(vals, w = 84, h = 22) {
  if (!vals || vals.length < 2) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals), r = hi - lo || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * (w - 4) + 2},${h - 3 - ((v - lo) / r) * (h - 6)}`);
  const up = vals[vals.length - 1] >= vals[0];
  const c = up ? "var(--neg)" : "#6e96ff";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${c}" stroke-width="1.5" points="${pts.join(" ")}"/><circle cx="${pts.at(-1).split(",")[0]}" cy="${pts.at(-1).split(",")[1]}" r="2.2" fill="${c}"/></svg>`;
}

function rateChart(pol, dxy, on, years) {
  const W = 760, H = 380, L = 40, R = 46, T = 12, B = 28;
  const keys = Object.keys(pol.series).filter((k) => on.has(k));
  const allM = [...new Set(Object.values(pol.series).flat().map(([m]) => m))].sort();
  const last = allM.at(-1);
  const startM = years ? `${+last.slice(0, 4) - years}-${last.slice(5)}` : allM[0];
  const months = allM.filter((m) => m >= startM);
  if (months.length < 2) return "";
  const x = (m) => L + (months.indexOf(m) / (months.length - 1)) * (W - L - R);
  const vals = keys.flatMap((k) => pol.series[k].filter(([m]) => m >= startM).map(([, v]) => v));
  const lo = Math.floor(Math.min(0, ...vals)), hi = Math.ceil(Math.max(1, ...vals));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let v = lo; v <= hi; v++) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`;
  const step = Math.max(1, Math.round(months.length / 8));
  months.forEach((m, i) => { if (i % step === 0) g += `<text x="${x(m)}" y="${H - 8}" text-anchor="middle" class="ax">${m}</text>`; });
  for (const k of keys) {
    const s = pol.series[k].filter(([m]) => m >= startM && months.includes(m));
    if (!s.length) continue;
    let d = `M${x(s[0][0])},${y(s[0][1])}`;
    for (let i = 1; i < s.length; i++) d += `H${x(s[i][0])}V${y(s[i][1])}`;
    g += `<path d="${d}" fill="none" stroke="${SERIES_COLOR[k] || "#aaa"}" stroke-width="2"/>`;
  }
  if (on.has("DXY") && dxy?.length) {
    const ds = dxy.filter(([m]) => m >= startM && months.includes(m));
    if (ds.length > 1) {
      const dl = Math.floor(Math.min(...ds.map(([, v]) => v)) / 5) * 5, dh = Math.ceil(Math.max(...ds.map(([, v]) => v)) / 5) * 5;
      const yd = (v) => T + (1 - (v - dl) / (dh - dl)) * (H - T - B);
      for (let v = dl; v <= dh; v += 5) g += `<text x="${W - R + 6}" y="${yd(v) + 4}" class="ax">${v}</text>`;
      g += `<polyline fill="none" stroke="#9aa4b5" stroke-dasharray="4 3" stroke-width="1.4" points="${ds.map(([m, v]) => `${x(m)},${yd(v)}`).join(" ")}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="주요국 기준금리 추이">${g}</svg>`;
}

function renderMacro(m, cal) {
  const el = $("#mac");
  if (!m) { el.innerHTML = `<div class="card">data/markets.json이 아직 없습니다. 평일 07:30·16:30(KST) 자동 수집 후 표시됩니다.</div>`; return; }
  let h = `<div class="sub" style="margin-bottom:8px">MARKET DATA · ${esc(m.updated || "")} 수집 · 평일 07:30·16:30(KST) 자동 갱신 · 정책금리는 월말 유효금리(step), 우측축은 달러인덱스(DXY) 월말 종가 · 등락은 국내 관례대로 상승 빨강·하락 파랑</div>`;

  // 1행: 금리 추이(좌) + 결정 일정·현재 정책금리(우)
  const pol = m.policy;
  h += `<div class="grid mac1">`;
  h += `<div class="card"><h3>1. 주요국 기준금리 추이 <span class="sub">${pol ? `${esc(Object.values(pol.series)[0]?.[0]?.[0] || "")} ~ 현재 · 좌: % · 우: DXY` : ""}</span></h3>`;
  if (pol) {
    h += `<div class="filters" id="polk">${pol.table.map((r) => `<button class="on" data-k="${r.key}"><i style="background:${SERIES_COLOR[r.key]}"></i>${esc(r.name.split(" ")[0])}</button>`).join("")}<button class="on" data-k="DXY"><i style="background:#9aa4b5"></i>DXY(우)</button></div>
      <div class="filters" id="poly"><button data-y="3">3Y</button><button data-y="5">5Y</button><button class="on" data-y="0">전체</button></div><div id="polc"></div>
      <div class="sub">출처: ${esc(pol.source)} · DXY: ${esc(m.indices_source || "Yahoo Finance")}</div>`;
  } else h += `<div class="sub">정책금리는 ECOS 수집 후 표시됩니다.</div>`;
  h += `</div><div class="card">`;
  if (pol) {
    h += `<h3>현재 정책금리</h3>${tm(`${pol.table[0]?.month || ""} 월말 유효금리`, "%, Δ는 bp")}<table class="mt"><thead><tr><th>중앙은행</th><th>현재</th><th>3M 전</th><th>1Y 전</th><th>Δ1Y(bp)</th></tr></thead><tbody>${pol.table.map((r) =>
      `<tr><td>${esc(r.name)}</td><td><b>${num(r.now)}</b></td><td>${num(r.m3)}</td><td>${num(r.y1)}</td><td class="${r.d1y_bp > 0 ? "neg" : r.d1y_bp < 0 ? "blu" : ""}">${r.d1y_bp == null ? "-" : `${r.d1y_bp > 0 ? "+" : ""}${r.d1y_bp}`}</td></tr>`).join("")}</tbody></table>`;
  }
  const nxt = (cal?.events || []).filter((e) => e.date >= new Date().toISOString().slice(0, 10)).slice(0, 4);
  if (nxt.length) h += `<h3 style="margin-top:12px">다음 금리 결정</h3>${nxt.map((e) => `<div class="cev"><span class="d">${e.date.slice(5).replace("-", "/")}</span><div><b>${esc(e.name)}</b> <span class="sub">${((n) => (n ? `D-${n}` : "오늘"))(Math.round((new Date(e.date) - new Date(new Date().toISOString().slice(0, 10))) / 864e5))}${e.note ? ` · ${esc(e.note)}` : ""}</span></div></div>`).join("")}`;
  h += `</div></div>`;

  // 결정 일정
  const today = new Date().toISOString().slice(0, 10);
  // 이번 달과 다음 달 일정만 보여 준다(파일에는 13개월치가 있음)
  const m0 = today.slice(0, 7), nx = new Date(+today.slice(0, 4), +today.slice(5, 7), 1), m1 = `${nx.getFullYear()}-${String(nx.getMonth() + 1).padStart(2, "0")}`;
  const evs = (cal?.events || []).filter((e) => [m0, m1].includes(e.date.slice(0, 7)));
  const byMon = {};
  for (const e of evs) (byMon[e.date.slice(0, 7)] ||= []).push(e);
  const result = (e) => {
    const s = pol?.series?.[e.bank];
    if (!s || e.date > today) return "예정";
    const i = s.findIndex(([mm]) => mm === e.date.slice(0, 7));
    if (i < 1) return "발표 반영 대기";
    const bp = Math.round((s[i][1] - s[i - 1][1]) * 100);
    return bp ? `결과: ${bp > 0 ? "+" : ""}${bp}bp, ${s[i][1].toFixed(2)}%` : `결과: 동결 ${s[i][1].toFixed(2)}%`;
  };
  h += `<div class="card" style="margin-top:12px"><h3>금리 결정 일정 <span class="sub">${Object.keys(byMon).map((k) => k.replace("-", ".")).join(" · ")}</span></h3><div class="cal">${Object.entries(byMon).map(([mon, list]) =>
    `<div><div class="mon">${+mon.slice(5)}월</div>${list.map((e) => `<div class="cev ${e.date < today ? "past" : ""}"><span class="d">${e.date.slice(5).replace("-", "/")}</span><div><b>${esc(e.name)}</b> <span class="${result(e).startsWith("결과") ? "res" : "sub"}">${esc(result(e))}</span>${e.note ? `<span class="sub"> · ${esc(e.note)}</span>` : ""}${e.source === "보조" ? ` <span class="chip" title="공식 페이지를 읽지 못해 공표 일정을 옮겨 적은 값">보조</span>` : ""}</div></div>`).join("")}</div>`).join("")}</div>
    <div class="sub">중앙은행 공식 일정 페이지에서 평일마다 자동 수집(${esc(cal?.updated || "")}). 중국 LPR은 매월 20일 규칙, <span class="chip">보조</span>는 공식 페이지를 읽지 못해 공표 일정을 옮겨 적은 값.</div></div>`;
  // 2. 지수 퍼포먼스
  const I = m.indices || [];
  const cols = [["1D", 3], ["1W", 5], ["1M", 8], ["3M", 12], ["6M", 20], ["YTD", 25], ["1Y", 30]];
  if (I.length) {
    h += `<div class="card wrap" style="margin-top:12px"><h3>2. 주요 지수 퍼포먼스 <span class="sub">${esc(m.indices_source || "")}</span></h3>${tm(`지수별 최근 종가 (${m.updated || ""} 수집)`, "pt, 등락 %")}<table class="mt"><thead><tr><th>지수</th><th>기준일</th><th>종가</th>${cols.map(([c]) => `<th>${c}</th>`).join("")}<th>12M 추이</th></tr></thead><tbody>`;
    let grp = "";
    for (const x of I) {
      if (x.group !== grp) { grp = x.group; h += `<tr class="grp"><td colspan="${cols.length + 4}">${esc(grp)}</td></tr>`; }
      h += `<tr><td><b>${esc(x.name)}</b>${x.stale ? ` <span class="chip">지연</span>` : ""}</td><td>${esc(x.date.slice(5).replace("-", "/"))}</td><td><b>${num(x.close)}</b></td>${cols.map(([c, sc]) => `<td style="${heat(x.chg[c], sc)}">${sgn(x.chg[c])}</td>`).join("")}<td>${spark(x.spark)}</td></tr>`;
    }
    h += `</tbody></table><div class="sub">1W·1M 등은 해당 기간 전 마지막 영업일 종가 대비, YTD는 전년 말 대비. 무료 지연 시세라 장중 값과 다를 수 있습니다.</div></div>`;

    // 3. 월말 MoM
    const sel = ["코스피", "S&P 500", "Euro Stoxx 50", "상해종합", "VN-Index", "IDX(자카르타)"].map((n) => I.find((x) => x.name === n)).filter((x) => x?.monthly?.length > 1);
    if (sel.length) {
      const months = [...new Set(sel.flatMap((x) => x.monthly.map(([mm]) => mm)))].sort().reverse().slice(0, 12);
      const mom = (x, mm) => {
        const i = x.monthly.findIndex(([k]) => k === mm);
        return i > 0 ? { v: x.monthly[i][1], c: (x.monthly[i][1] / x.monthly[i - 1][1] - 1) * 100 } : i === 0 ? { v: x.monthly[0][1], c: null } : null;
      };
      const cum = (x) => {
        const a = x.monthly.find(([k]) => k === months.at(-1)), i = x.monthly.findIndex(([k]) => k === months.at(-1));
        const base = i > 0 ? x.monthly[i - 1][1] : a?.[1];
        return base ? (x.monthly.at(-1)[1] / base - 1) * 100 : null;
      };
      h += `<div class="card wrap" style="margin-top:12px"><h3>3. 월말 지수 · 전월 대비(MoM) <span class="sub">Trailing 12 months</span></h3>${tm(`월말 종가, ${months[0].replace("-", ".")}은 최근 종가`, "pt, MoM %")}<table class="mt"><thead><tr><th rowspan="2">월말</th>${sel.map((x) => `<th colspan="2" class="c">${esc(x.name)}</th>`).join("")}</tr><tr>${sel.map(() => "<th>지수</th><th>MoM</th>").join("")}</tr></thead><tbody>`;
      months.forEach((mm, i) => {
        h += `<tr><td><b>${mm.replace("-", ".")}${i === 0 ? "*" : ""}</b></td>${sel.map((x) => { const r = mom(x, mm); return `<td>${r ? num(r.v) : "-"}</td><td style="${heat(r?.c, 12)}">${r?.c == null ? "-" : sgn(r.c, 1)}</td>`; }).join("")}</tr>`;
      });
      h += `<tr class="tot"><td><b>12M 누적</b></td>${sel.map((x) => { const c = cum(x); return `<td></td><td style="${heat(c, 30)}"><b>${sgn(c, 1)}</b></td>`; }).join("")}</tr></tbody></table><div class="sub">* 이번 달은 최근 종가 기준(월중).</div></div>`;
    }
  }

  // 4. 환율 + 교차환율
  const F = m.fx?.rows || [];
  if (F.length) {
    const per1 = Object.fromEntries([["KRW", 1], ...F.map((r) => [r.ccy, r.krw / r.unit])]);
    const unit = Object.fromEntries([["KRW", 1], ...F.map((r) => [r.ccy, r.unit])]);
    const cc = ["KRW", ...F.map((r) => r.ccy)];
    const cross = (a, b) => (per1[a] * unit[a]) / per1[b];
    const fm = (v) => (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toExponential(2));
    h += `<div class="card wrap" style="margin-top:12px"><h3>4. 환율 <span class="sub">${esc(m.fx.source)}</span></h3><div class="grid fxg"><div>${tm(`${m.fx.date || ""} 매매기준율${F[0]?.prev_date ? `, 비교 ${F[0].prev_date}` : ""}`, "원(JPY·VND·IDR 100단위), %")}<table class="mt"><thead><tr><th>통화</th><th>단위</th><th>원화</th><th>1주 전</th><th>1W</th></tr></thead><tbody>${F.map((r) =>
      `<tr><td><b>${r.ccy}</b> <span class="sub">${esc(r.name)}</span></td><td>${r.unit}</td><td><b>${num(r.krw)}</b></td><td>${num(r.prev)}</td><td class="${r.chg_1w > 0 ? "neg" : r.chg_1w < 0 ? "blu" : ""}">${sgn(r.chg_1w)}</td></tr>`).join("")}</tbody></table></div>
      <div>${tm(`${m.fx.date || ""} 원화 환율로 계산`, "열 통화")}<table class="mt"><thead><tr><th></th>${cc.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${cc.map((a) => `<tr><td><b>${a}</b>${unit[a] > 1 ? ` <span class="sub">×${unit[a]}</span>` : ""}</td>${cc.map((b) => `<td>${a === b ? "—" : fm(cross(a, b))}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div class="sub">교차환율: 행 통화 1단위(JPY·VND·IDR은 100단위)가 열 통화로 얼마인지. 원화 매매기준율로 계산.</div></div></div></div>`;
  }

  el.innerHTML = h;

  if (pol) {
    const on = new Set([...pol.table.map((r) => r.key).filter((k) => !["UK", "CN", "IN", "CA"].includes(k)), "DXY"]);
    let yrs = 0;
    const draw = () => {
      $("#polc").innerHTML = rateChart(pol, m.dxy_monthly, on, yrs);
      document.querySelectorAll("#polk button").forEach((b) => b.classList.toggle("on", on.has(b.dataset.k)));
      document.querySelectorAll("#poly button").forEach((b) => b.classList.toggle("on", +b.dataset.y === yrs));
      fit();
    };
    document.querySelectorAll("#polk button").forEach((b) => b.addEventListener("click", () => { on.has(b.dataset.k) ? on.delete(b.dataset.k) : on.add(b.dataset.k); draw(); }));
    document.querySelectorAll("#poly button").forEach((b) => b.addEventListener("click", () => { yrs = +b.dataset.y; draw(); }));
    draw();
  }
}

// 첫 화면 상단에 데이터 누락·기한 경과 같은 예외를 모아 보여 준다
function health(dart, reg, macro, ents) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = (reg?.todo || []).filter((t) => t.status !== "done" && t.due && t.due < today).length;
  const keys = (ents || []).map((e) => e.key), P = dart?.periods || [];
  const missing = P.length ? keys.filter((k) => !P.at(-1).subs?.[k]).length : 0;
  const fy = [...P].reverse().find((p) => p.period === "FY" && p !== P.at(-1));
  const missF = fy ? keys.filter((k) => !fy.subs?.[k]).length : 0;
  const noStake = P.length ? keys.filter((k) => dart.stakes?.[k] == null).length : 0;
  const items = [
    [!P.length, "bad", "공시 데이터 없음"],
    [missing > 0, "warn", `최신 공시에 없는 법인 ${missing}곳`],
    [missF > 0, "warn", `${fy?.label} 공시에 없는 법인 ${missF}곳`],
    [noStake > 0, "warn", `지분율 없는 법인 ${noStake}곳 (100%로 계산)`],
    [overdue > 0, "bad", `기한 경과 대외보고 ${overdue}건`],
    [!macro, "warn", "시장 데이터 미수집"],
  ].filter(([on]) => on);
  $("#health").innerHTML = items.map(([, c, t]) => `<span class="chip ${c}">${t}</span>`).join("")
    || `<span class="chip ok">데이터 정상</span>`;
}

(async () => {
  if (embedded) document.querySelectorAll("header h1, header #asof").forEach((x) => (x.style.display = "none"));
  tabs();
  const [dart, ents, inv, reg, markets, cal] = await Promise.all([load("dart_subs.json"), load("entities.json"), load("investments.json"), load("regulatory.json"), load("markets.json"), load("rate_calendar.json")]);
  if (dart?.periods?.length && ents?.entities) {
    const L = dart.periods.at(-1);
    $("#asof").textContent = `미래전략실 글로벌네트워크팀 · 해외자회사 4사 · DART ${L.label} ${L.report.name} 기준`;
    renderPL(dart, ents.entities, reg);
    renderEnt(dart, ents.entities, inv);
  } else {
    $("#pl").innerHTML = $("#ent").innerHTML = `<div class="card">data/dart_subs.json(DART 공시)을 불러오지 못했습니다. 평일 자동 수집 후 표시됩니다.</div>`;
  }
  if (reg) renderReg(reg);
  renderMacro(markets, cal);
  health(dart, reg, markets, ents?.entities);
  fit();
  setTimeout(fit, 500);
})();
