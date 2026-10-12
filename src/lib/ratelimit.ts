/**
 * 공개 API 호출 제한(인스턴스별 슬라이딩 윈도).
 *
 * 서버리스라 인스턴스마다 따로 센다. 정확한 전역 제한은 아니지만, 같은 주소를 반복해서 두드리는
 * 단순 남용(엣지 캐시에 안 걸리는 서로 다른 주소를 계속 만들어 DB 를 치는 경우 포함)을 막는 데는 충분하다.
 * 엣지 캐시에 맞은 요청은 함수까지 오지 않으므로 평소 사용에는 영향이 없다.
 */
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
let lastSweep = 0;

export function clientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for') ?? '';
  return xf.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

/** true 면 제한 초과. max 는 분당 허용 횟수. */
export function overLimit(req: Request, max = 90, bucket = 'api', now = Date.now()): boolean {
  if (now - lastSweep > WINDOW_MS) {
    lastSweep = now;
    for (const [k, v] of hits) if (v.every((t) => now - t > WINDOW_MS)) hits.delete(k);
  }
  const key = `${bucket}:${clientIp(req)}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t <= WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

export function resetRateLimit() {
  hits.clear();
  lastSweep = 0;
}
