import { Noto_Sans_KR } from "next/font/google";
import "./globals.css";

const noto = Noto_Sans_KR({ subsets: ["latin"], weight: ["400", "500", "700"] });

export const metadata = {
  title: "AI 과제 검증 인터뷰",
  description: "학생이 과제를 직접 작성했는지 AI 면접관이 인터뷰로 검증합니다. PDF 업로드 후 3분 음성 인터뷰로 과제 이해도와 작성 과정을 확인하세요.",
  openGraph: {
    title: "AI 과제 검증 인터뷰",
    description: "학생이 과제를 직접 작성했는지 AI 면접관이 인터뷰로 검증합니다. PDF 업로드 후 3분 음성 인터뷰로 과제 이해도와 작성 과정을 확인하세요.",
    type: "website",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary",
    title: "AI 과제 검증 인터뷰",
    description: "학생이 과제를 직접 작성했는지 AI 면접관이 인터뷰로 검증합니다.",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className={noto.className}>{children}</body>
    </html>
  );
}
