'use client';

/**
 * 별 배지. 텔레그램 알림과 같은 기준(/api/stars)을 웹에서 보여준다.
 * 아이콘은 이모지 대신 직접 그린 단순한 별 SVG, 배지는 테두리 없는 연한 채움 알약이다.
 */
import { useEffect, useState } from 'react';
import type { Badge, SymbolBadges } from '@/domain/starBadges';

const LABEL: Record<keyof SymbolBadges, string> = {
  institution: '기관',
  private_fund: '사모',
  foreign: '외국인',
  individual: '개인 매도',
  handbuy: '손매수',
};
const ORDER: Array<keyof SymbolBadges> = ['institution', 'private_fund', 'foreign', 'handbuy', 'individual'];
const TIER_KO = ['', '상위 2% 이내', '상위 0.5% 이내', '상위 0.2% 이내'];

export function StarMark({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M12 2.6l2.9 6.1 6.7.8-4.9 4.6 1.3 6.6L12 17.4 6 20.7l1.3-6.6L2.4 9.5l6.7-.8L12 2.6z" />
    </svg>
  );
}

function won(v: number) {
  const a = Math.abs(v);
  return a >= 1e8 ? `${(a / 1e8).toFixed(1)}억` : `${Math.round(a / 1e4).toLocaleString('ko-KR')}만원`;
}

function tip(label: string, b: Badge) {
  const amount = `${b.amount >= 0 ? '순매수' : '순매도'} ${won(b.amount)}`;
  const pct = b.pct !== null ? ` (${b.basis} ${Math.abs(b.pct).toFixed(2)}%)` : '';
  const tier = b.stars > 0 ? ` · ${TIER_KO[b.stars]}` : '';
  return `${label} ${amount}${pct}${tier}`;
}

export function StarBadges({ badges, dense = false }: { badges?: SymbolBadges; dense?: boolean }) {
  const items = ORDER.flatMap((k) => {
    const b = badges?.[k];
    if (!b) return [];
    if (k === 'individual' ? b.stars === 0 && !b.warn : b.stars === 0) return [];
    return [{ k, b }];
  });
  if (items.length === 0) return <span className="text-faint">-</span>;
  return (
    <div className={`flex flex-wrap ${dense ? 'gap-1' : 'gap-1.5'}`}>
      {items.map(({ k, b }) =>
        b.stars > 0 ? (
          <span key={k} className="tag tag-star" title={tip(LABEL[k], b)}>
            {LABEL[k]}
            <span className="flex items-center gap-px text-gold" aria-label={`별 ${b.stars}개`}>
              {Array.from({ length: b.stars }, (_, i) => <StarMark key={i} />)}
            </span>
          </span>
        ) : (
          <span key={k} className="tag tag-mute-fill" title={tip('개인', b)}>
            개인 추격 주의
          </span>
        ),
      )}
    </div>
  );
}

/** 기준일·종목 목록이 바뀔 때 한 번에 받아 온다. 실패하면 배지만 비고 화면은 그대로다. */
export function useStarBadges(date: string, symbols: string[]): Record<string, SymbolBadges> {
  const [map, setMap] = useState<Record<string, SymbolBadges>>({});
  const key = symbols.join(',');
  useEffect(() => {
    if (!date || !key) { setMap({}); return; }
    let alive = true;
    (async () => {
      try {
        const out: Record<string, SymbolBadges> = {};
        const list = key.split(',');
        for (let i = 0; i < list.length; i += 100) {
          const res = await fetch(`/api/stars?date=${date}&symbols=${list.slice(i, i + 100).join(',')}`);
          const body = await res.json().catch(() => null);
          if (res.ok && body?.badges) Object.assign(out, body.badges);
        }
        if (alive) setMap(out);
      } catch {
        if (alive) setMap({});
      }
    })();
    return () => { alive = false; };
  }, [date, key]);
  return map;
}
