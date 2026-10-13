import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "Tiny Sword Survivors — клон Vampire Survivors",
  description:
    "Выживи 15 минут в толпе врагов! Bullet-heaven роглайт на Phaser 4 с ассетами Tiny Swords от Pixel Frog. 4 героя, 7 оружий, боссы, мета-магазин и достижения.",
  keywords: ["игра", "Phaser", "Vampire Survivors", "Tiny Swords", "roguelite", "bullet heaven"],
  openGraph: {
    title: "Tiny Sword Survivors — выживи 15 минут!",
    description:
      "Bullet-heaven роглайк на Phaser 4: 4 героя, 7 оружий, элиты, бочки-камикадзе и Чёрный Копейщик на 15-й минуте. Ассеты Tiny Swords от Pixel Frog.",
    type: "website",
    locale: "ru_RU",
  },
  twitter: {
    card: "summary",
    title: "Tiny Sword Survivors",
    description: "Выживи 15 минут в толпе врагов! Bullet-heaven роглайк на Phaser 4.",
  },
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#3f8ed0",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
