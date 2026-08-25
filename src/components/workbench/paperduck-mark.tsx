export function PaperDuckMark({ compact = false }: { compact?: boolean }) {
  return <span className="brand-mark" aria-hidden="true"><span className="brand-duck">鸭</span>{!compact && <span className="brand-print">◆</span>}</span>;
}
