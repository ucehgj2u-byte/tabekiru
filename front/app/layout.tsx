import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Mogu — 食材を、おいしく使いきる";
const description =
  "写真から食材を登録し、期限管理・使いきり通知・レシピ提案で家庭の食品ロスを減らす在庫アプリ。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(host ? `${protocol}://${host}` : "http://localhost:3000");
  return {
    metadataBase,
    title,
    description,
    openGraph: {
      title,
      description: "撮るだけ在庫管理。期限が近い食材から、おいしく使いきろう。",
      type: "website",
      images: [{ url: "/og.png", width: 1734, height: 907, alt: "Mogu" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
