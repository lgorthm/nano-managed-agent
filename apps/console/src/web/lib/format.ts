const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'medium',
});
const shortTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

/** 紧凑时间(09/11 00:48),移动端表格列用,桌面端仍用 formatTime */
export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : shortTimeFmt.format(d);
}

export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 18)}…` : id;
}

export function formatNumber(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('zh-CN');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
