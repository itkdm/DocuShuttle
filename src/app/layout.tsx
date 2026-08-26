import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "纸上鸭 · Word 文档 Agent",
  description: "理解、生成、修改并交付真实 Word 文档。",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
