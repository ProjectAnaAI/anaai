import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import ActiveBusinessProvider from "@/components/layout/ActiveBusinessProvider";

export const metadata: Metadata = {
  title: "AnaAI by ZUDE",
  description: "AI receptionist and appointment workspace for service businesses",
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
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
