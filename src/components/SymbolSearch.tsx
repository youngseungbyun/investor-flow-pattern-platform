'use client';

/**
 * 종목 바로가기.
 *
 * 조건 검색은 "조건에 맞는 종목을 찾는" 도구라, 이미 종목을 알고 있을 때 쓸 길이 없었다.
 * 표를 훑어 이름을 찾거나 URL 을 직접 치는 수밖에 없었다.
 * 이름 일부·종목코드 어느 쪽으로도 찾고 위아래 키로 골라 들어간다.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr';

interface Hit {
  symbol: string;
  name: string;
  market: string;
  traded_value: string | null;
}

const won = (v: string | null) => {
  const n = Number(v ?? 0);
  if (!n) return '';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}조`;
  if (n >= 1e8) return `${Math.round(n / 1e8)}억`;
  return '';
};

export default function SymbolSearch() {
  const router = useRouter();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  // 한 글자 칠 때마다 요청하면 서버가 앞선 응답을 늦게 돌려줘 목록이 뒤집힌다.
  // 200ms 쉬었다 보내고, 새 요청이 뜨면 이전 것은 버린다.
  useEffect(() => {
    const t = term.trim();
    if (t.length === 0) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/find?q=${encodeURIComponent(t)}`, { signal: ac.signal })
        .then((r) => r.json())
        .then((d) => {
          setHits(Array.isArray(d.items) ? d.items : []);
          setCursor(0);
          setBusy(false);
        })
        .catch(() => {
          /* 취소된 요청은 무시한다 */
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [term]);

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // 어디서든 / 를 누르면 검색으로 들어온다. 입력 중일 때는 그냥 슬래시가 찍혀야 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = useCallback(
    (h: Hit) => {
      setOpen(false);
      setTerm('');
      router.push(`/stock/${h.symbol}`);
    },
    [router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[cursor]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    // 입력 폭은 고정이다. 포커스 때 넓어지게 뒀더니 옆의 기준일 컨트롤이 밀려났고,
    // width 애니메이션이라 열고 닫을 때마다 레이아웃을 다시 계산했다.
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-1.5 rounded-[var(--r-pill)] bg-surface-3 pl-2.5 pr-1.5">
        <MagnifyingGlass size={14} weight="bold" className="shrink-0 text-faint" />
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="종목명 · 코드"
          aria-label="종목 바로가기"
          className="w-[132px] bg-transparent py-[6px] text-[13px] text-fg outline-none placeholder:text-faint sm:w-[184px]"
        />
        {term ? (
          busy ? (
            <span className="spinner !size-3 text-faint" aria-hidden />
          ) : (
            <button
              type="button"
              onClick={() => { setTerm(''); inputRef.current?.focus(); }}
              className="btn btn-quiet !px-1.5 !py-0.5 !text-[11px]"
              aria-label="지우기"
            >
              지움
            </button>
          )
        ) : (
          <kbd className="hidden rounded bg-surface px-1.5 py-0.5 text-[10.5px] text-faint sm:block">/</kbd>
        )}
      </div>

      {open && term.trim().length > 0 && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-[300px] overflow-hidden rounded-[var(--r-panel)] bg-surface shadow-[0_12px_32px_rgb(0_0_0/0.34)]">
          {hits.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-faint">
              {busy ? '찾는 중이에요' : `'${term.trim()}' 와 맞는 종목이 없어요`}
            </p>
          ) : (
            <ul role="listbox">
              {hits.map((h, i) => (
                <li key={h.symbol}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(h)}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left"
                    style={{ background: i === cursor ? 'var(--s3)' : 'transparent' }}
                  >
                    <span className="truncate text-[13px] font-semibold text-fg">{h.name}</span>
                    <span className="num shrink-0 text-[11.5px] text-faint">{h.symbol}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">
                      {won(h.traded_value) || h.market}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
