import { Noto_Sans_KR } from "next/font/google";
import "./globals.css";

const noto = Noto_Sans_KR({ subsets: ["latin"], weight: ["400", "500", "700"] });

export const metadata = {
  title: "Homework Validator",
  description: "PDF 기반 AI 인터뷰로 과제 이해도를 확인하는 도구",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className={noto.className}>{children}</body>
    </html>
  );
}
