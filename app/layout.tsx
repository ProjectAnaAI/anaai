import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnaAI",
  description: "AI Receptionist for Modern Salons",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}