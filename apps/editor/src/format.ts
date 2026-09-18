import type { MarkerRegion } from './api/client';

export const formatRegion = (region: MarkerRegion | null | undefined): string =>
  region
    ? `Custom area — ${Math.round(region.width * 100)}% × ${Math.round(region.height * 100)}% of screen`
    : 'Full screen';
