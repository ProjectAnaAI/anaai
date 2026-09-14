import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import ActiveBusinessProvider from "@/components/layout/ActiveBusinessProvider";

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
      <body>
        <ActiveBusinessProvider>{children}</ActiveBusinessProvider>
        <Toaster />
      </body>
    </html>
  );
}