import { Link } from '@tanstack/react-router';
import icon from '@/assets/oort-icon.png';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <img src={icon} alt="Oort Cloud" width={28} height={28} className="size-7 rounded-md" />
      <span className="text-[15px] font-semibold tracking-tight">Oort</span>
      {!compact && (
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          v0.4 · Apache 2.0
        </span>
      )}
    </Link>
  );
}
