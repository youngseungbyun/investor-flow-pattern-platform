'use client';

import { useEffect, useRef } from 'react';

const nf = new Intl.NumberFormat('ko-KR');

/**
 * 값이 0에서 목표치까지 올라가는 카운트업.
 * Magic UI NumberTicker 와 같은 연출인데, 이 앱에 motion 을 새로 넣지 않으려고
 * requestAnimationFrame 으로 직접 구현했다(데이터 터미널에 애니메이션 라이브러리
 * 40KB 를 얹을 이유가 없다).
 *
 * 중요: 프레임마다 setState 를 부르면 React 트리가 60번/초 리렌더된다.
 * ref 로 DOM textContent 만 직접 쓴다.
 *
 * 이 모션이 필요한 이유: 배치가 방금 돌아 숫자가 갱신됐다는 걸 알려준다.
 * 값이 그냥 박혀 있으면 어제 숫자인지 오늘 숫자인지 구분되지 않는다.
 */
export default function NumberTicker({
  value,
  duration = 900,
  suffix = '',
  className,
}: {
  value: number;
  duration?: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!Number.isFinite(value)) {
      el.textContent = '-';
      return;
    }

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || value === 0) {
      el.textContent = nf.format(Math.round(value)) + suffix;
      return;
    }

    let raf = 0;
    let start = 0;
    // 끝에서 부드럽게 멎는 감속. 선형이면 숫자가 툭 끊긴다.
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    const tick = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / duration);
      el.textContent = nf.format(Math.round(value * easeOut(t))) + suffix;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [value, duration, suffix]);

  return (
    <span ref={ref} className={className}>
      0{suffix}
    </span>
  );
}
