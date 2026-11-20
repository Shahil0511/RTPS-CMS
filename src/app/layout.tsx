import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Libas VMS", template: "%s · Libas VMS" },
  description: "Video management system: live monitoring, playback, health, permissions and audit.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

/** Theme comes from a cookie set by the toggle, so the right palette renders on the server with no flash. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const dark = (await cookies()).get("vms-theme")?.value === "dark";
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}${dark ? " dark" : ""}`}>
      <body className="min-h-dvh">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
