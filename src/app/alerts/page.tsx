'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface RulesPayload {
  rules: Array<{ id: string; name: string; lines: string[] }>;
  filters: string[];
}
interface PreviewPayload {
  date: string;
  prev: string | null;
  rules: Array<{ id: string; name: string; lines: string[]; matched: number; fresh: number; kept: string[] }>;
  symbols: string[];
  text: string;
}

async function load<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.error === 'string') throw new Error(body?.error ?? `응답 ${res.status}`);
  return body as T;
}

export default function AlertsPage() {
  const [rules, setRules] = useState<RulesPayload | null>(null);
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [homeHref, setHomeHref] = useState('/');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try { setHomeHref(sessionStorage.getItem('sd-home') || '/'); } catch { /* 기본 주소 */ }
    load<RulesPayload>('/api/alert-rules').then(setRules).catch((e: unknown) => setErr(e instanceof Error ? e.message : '불러오지 못했어요'));
    load<{ counts: Record<string, string | null> }>('/api/status')
      .then((st) => setDate(String(st.counts.last_complete_day || st.counts.last_trading_day || '')))
      .catch(() => { /* 날짜는 직접 고를 수 있다 */ });
  }, []);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    load<PreviewPayload>(`/api/alert-preview?date=${date}`)
      .then((p) => { if (alive) setPreview(p); })
      .catch((e: unknown) => { if (alive) { setPreview(null); setErr(e instanceof Error ? e.message : '미리보기를 만들지 못했어요'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [date]);

  const copy = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 복사 권한이 없으면 글상자에서 직접 선택 */ }
  };

  return (
    <main className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
          <Link href={homeHref} className="btn btn-quiet !px-2 !py-1 !text-[12.5px]">← 스크리너</Link>
          <h1 className="text-[15px] font-semibold tracking-[-0.012em]">알림 설정</h1>
          <span className="text-[12.5px] text-faint">장 마감 텔레그램 알림이 어떤 조건으로 만들어지는지 보여줘요</span>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] space-y-4 px-5 py-5">
        {err && <p className="rounded-xl bg-[var(--gold-soft)] px-4 py-3 text-[13px] text-warn">{err}</p>}

        <section className="panel">
          <div className="panel-head"><div>
            <h2 className="panel-title">지금 돌고 있는 알림 조건</h2>
            <p className="panel-desc">평일 장 마감 직후(16:35) 아래 조건마다 새로 걸린 종목을 찾아 한 통으로 보내요. 조건을 바꾸려면 아직은 AI에게 요청해야 해요.</p>
          </div></div>
          <div className="panel-body space-y-3">
            {rules?.rules.map((r) => (
              <div key={r.id} className="rounded-xl bg-surface-2 p-4">
                <div className="text-[14px] font-semibold">{r.name}</div>
                <ul className="mt-2 space-y-1 text-[12.5px] text-mute">
                  {r.lines.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </div>
            ))}
            {rules && (
              <div className="rounded-xl bg-surface-2 p-4">
                <div className="text-[14px] font-semibold">모든 조건에 공통으로 거르는 기준</div>
                <ul className="mt-2 space-y-1 text-[12.5px] text-mute">
                  {rules.filters.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </div>
            )}
            {!rules && !err && <div className="skel h-24" />}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head flex-wrap gap-y-2">
            <div>
              <h2 className="panel-title">오늘 알림 미리보기</h2>
              <p className="panel-desc">선택한 날짜 기준으로 같은 순서로 걸러 만든 글이에요. 실제 발송은 그날 수집이 끝난 뒤 한 번만 가요.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" aria-label="기준일" />
              <button className="btn btn-quiet" onClick={() => void copy()} disabled={!preview}>{copied ? '복사됨' : '글 복사'}</button>
            </div>
          </div>
          <div className="panel-body space-y-3">
            {loading && <div className="skel h-40" />}
            {!loading && preview && (
              <>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-mute">
                  {preview.rules.map((r) => (
                    <span key={r.id}>
                      <b className="text-fg">{r.id === 'main' ? '기본' : '참고'}</b> 조건 {r.matched}종목 → 신규 {r.fresh} → 거른 뒤 {r.kept.length}
                      {r.kept.length > 0 && <span className="text-faint"> ({r.kept.join(', ')})</span>}
                    </span>
                  ))}
                  {preview.prev && <span className="text-faint">신규 판단 기준일 {preview.prev}</span>}
                </div>
                <pre className="whitespace-pre-wrap rounded-xl bg-surface-2 p-4 text-[13px] leading-[1.7]" style={{ fontFamily: 'inherit' }}>{preview.text}</pre>
              </>
            )}
          </div>
        </section>

        <p className="text-[11.5px] leading-relaxed text-faint">
          수집한 데이터의 사실과 순위만 보여줘요. 종목 추천이 아니며, 투자 판단과 책임은 이용자 본인에게 있어요.
        </p>
      </div>
    </main>
  );
}
