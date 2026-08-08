import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';

/**
 * Astryx 가 쓰는 서체. 라틴·숫자만 포함돼 있어 한글은 CSS 스택에서 Pretendard 로 떨어진다.
 * 덕분에 숫자는 Figtree 의 균일한 tabular 자형을, 한글은 Pretendard 를 각각 쓴다.
 */
const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-figtree',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '수급·패턴 분석',
  description:
    '개인·외국인·기관 세부 수급을 차트 패턴·지지선과 조합해 조건 검색하는 국내 주식 분석 대시보드. 사실과 순위만 제공하며 종목 추천이 아닙니다.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0e' },
    { media: '(prefers-color-scheme: light)', color: '#f6f6f7' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * 테마를 첫 페인트 전에 확정한다.
 * 이 스크립트가 없으면 다크로 저장해 둔 사용자에게 흰 화면이 한 번 번쩍인다.
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('sd-theme');if(!t){t='dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" data-theme="dark" className={figtree.variable} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
