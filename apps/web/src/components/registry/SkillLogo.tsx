import { useState } from "react";

export function SkillLogo({ src, tone, size, className }: { src?: string; tone: string; size?: "32"; className?: string }) {
  const [failed, setFailed] = useState<string>();
  return <span className={className ?? "registry-tile"} data-tone={tone} data-size={size} aria-hidden="true">
    {src && failed !== src && <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} />}
  </span>;
}
