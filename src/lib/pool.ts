/**
 * 동시에 n 개까지만 돌리는 작업 풀.
 *
 * KIS 호출은 종목당 1건이라 하나씩 await 하면 왕복 지연(러너↔KIS 약 150ms)이
 * 그대로 쌓여 초당 7건 남짓밖에 못 낸다. 초당 한도(15건)는 kis.ts 의 gate() 가
 * 전역으로 지키므로, 여기서는 요청을 겹쳐 보내기만 하면 한도 근처까지 올라간다.
 * 결과 순서는 입력 순서와 같다.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number) => void,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
