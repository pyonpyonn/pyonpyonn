// SETUP: code "app/layout.tsx"
//
// Root layout — fonts, metadata, and the components that appear on every page.

import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

import TopBar from "@/components/TopBar";
import SiteHeader from "@/components/SiteHeader";
import Toaster from "@/components/Toaster";
import RatingGate from "@/components/RatingGate";
import SupportChat from "@/components/SupportChat";

// Self-hosted by Next, so no extra request to Google and no flash of
// unstyled text. Components ask for "Nunito" by name and get this.
const nunito = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-nunito",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "Opulence Bliss — home cleaning & massage in London",
  description:
    "Vetted cleaners and massage therapists at your home across London. Book a single visit or a monthly membership. Pay after the visit.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${nunito.className} ${nunito.variable}`}
      suppressHydrationWarning
    >
      <body>
        <TopBar />
        <SiteHeader />
        {children}
        <Toaster />
        <RatingGate />
        <SupportChat />
      </body>
    </html>
  );
}
