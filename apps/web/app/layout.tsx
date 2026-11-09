import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Answer Everything", template: "%s · Answer Everything" },
  description: "Ask anything. Get the strongest available answer, with the evidence behind it.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f8f6f2" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
