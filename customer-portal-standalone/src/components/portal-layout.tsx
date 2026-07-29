import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard,
  History,
  Star,
  User,
  LogOut,
  Wifi,
  ShoppingBag,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/packages", label: "Packages", icon: ShoppingBag },
  { href: "/sessions", label: "Sessions", icon: History },
  { href: "/loyalty", label: "Loyalty", icon: Star },
  { href: "/profile", label: "Profile", icon: User },
];

interface PortalLayoutProps {
  children: ReactNode;
  title?: string;
}

export function PortalLayout({ children, title }: PortalLayoutProps) {
  const [location, navigate] = useLocation();
  const { customer, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="bg-primary text-white sticky top-0 z-10 shadow">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wifi className="w-5 h-5" />
            <span className="font-bold">PulseNet</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/90">{customer?.firstName}</span>
            <button
              onClick={logout}
              title="Sign out"
              className="text-white/80 hover:text-white"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        {title && (
          <div className="max-w-lg mx-auto px-4 pb-3">
            <h1 className="text-lg font-semibold">{title}</h1>
          </div>
        )}
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-5">{children}</main>

      {/* Bottom nav */}
      <nav className="sticky bottom-0 bg-white border-t shadow-lg safe-area-inset-bottom">
        <div className="max-w-lg mx-auto flex">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = location === href || location.startsWith(href + "/");
            return (
              <button
                key={href}
                onClick={() => navigate(href)}
                className={cn(
                  "flex-1 flex flex-col items-center gap-0.5 py-2 text-xs transition-colors",
                  active
                    ? "text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn("w-5 h-5", active && "text-primary")} />
                {label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
