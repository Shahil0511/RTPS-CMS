import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="text-center">
        <p className="text-6xl font-semibold text-faint">404</p>
        <h1 className="mt-2 text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted">The page does not exist or you do not have access to it.</p>
        <Link href="/" className={buttonClasses("primary", "md", "mt-5")}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
