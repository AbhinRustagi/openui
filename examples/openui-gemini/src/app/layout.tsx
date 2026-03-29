import type { Metadata } from "next";
import { ThemeProvider } from "@/hooks/use-system-theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenUI + Gemini",
  description: "Generative UI Chat with Google Gemini",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
