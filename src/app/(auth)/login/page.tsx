import { Camera, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const { next } = await searchParams;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[var(--brand-panel)] p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(76,154,255,0.45),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(110,93,198,0.35),transparent_50%)]" />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent">
            <Camera className="h-5 w-5" />
          </span>
          <div>
            <p className="text-lg font-semibold">Libas VMS</p>
            <p className="text-xs text-white/60">Video Management System</p>
          </div>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight">Every store, every camera, one secure console.</h2>
          <ul className="mt-6 space-y-3 text-sm text-white/75">
            <li className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-white/90" /> Live monitoring over WebRTC with HLS fallback</li>
            <li className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-white/90" /> Playback straight from each site's NVR/DVR, no extra storage</li>
            <li className="flex gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-white/90" /> NVR, disk and camera health with store-wise access and audit</li>
          </ul>
        </div>
        <p className="relative text-xs text-white/40">Authorised personnel only. All activity is recorded.</p>
      </section>

      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-white">
              <Camera className="h-5 w-5" />
            </span>
            <p className="text-lg font-semibold">Libas VMS</p>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Use your VMS account to continue.</p>
          <div className="mt-6">
            <LoginForm next={next} />
          </div>
        </div>
      </section>
    </div>
  );
}
