// Pure display helpers (no network, no state). All calendar computations use
// America/Sao_Paulo explicitly — never slice UTC ISO timestamps to derive
// local dates, which breaks on day boundaries.

// IANA zone for every cinema in the catalog (all are in SP/RJ).
export const CATALOG_TIME_ZONE = 'America/Sao_Paulo';

const dayKeyFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: CATALOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dayLabelFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: CATALOG_TIME_ZONE,
  weekday: 'long',
  day: '2-digit',
  month: 'long',
});

const timeFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: CATALOG_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});

const priceFormat = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

// Stable grouping key for one calendar day in the catalog zone (dd/mm/yyyy).
export function screeningDayKey(startsAtIso: string): string {
  return dayKeyFormat.format(new Date(startsAtIso));
}

export function formatDayLabel(startsAtIso: string): string {
  const label = dayLabelFormat.format(new Date(startsAtIso));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatStartTime(startsAtIso: string): string {
  return timeFormat.format(new Date(startsAtIso));
}

export function formatPrice(priceCents: number): string {
  return priceFormat.format(priceCents / 100);
}
