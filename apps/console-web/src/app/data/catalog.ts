/**
 * Pricing for the catalog the API serves.
 *
 * This file used to be the catalog: ten hardcoded flavours, six datacentres and seven image
 * families, all of them read off a commercial provider's console along with its real euro prices.
 * None of it described this system, which runs on one standalone Proxmox node with two flavours
 * and one network — so a console rendering it was describing somebody else's product.
 *
 * The flavours, images and networks now come from
 * `/v1/projects/{id}/catalog/{flavors,images,networks}`, which is the authority.
 *
 * What stays is price, because the control plane has no price to serve yet. Billing is planned
 * work rather than an excluded concern, so the figures below are the table the billing service
 * will replace — keyed by the **real** flavour identifiers, so a flavour the API adds simply has
 * no entry until someone prices it, rather than silently inheriting a stranger's rate.
 */

/** Monthly price by flavour id. Extend when a flavour is added to the catalog. */
const FLAVOR_PRICES: Readonly<Record<string, number>> = {
  'lab-small': 4.51,
  'lab-medium': 8.98,
};

/** Monthly price of the leased IPv4 address every instance receives. */
export const IPV4_PRICE_PER_MONTH = 0.5;

/** Monthly price per stored snapshot gigabyte. */
export const SNAPSHOT_PRICE_PER_GB = 0.0143;

/**
 * The monthly price for a flavour.
 *
 * Returns `0` for a flavour with no entry. A zero here means "not priced yet", and the UI shows it
 * as such rather than as free — the alternative, guessing from another flavour's rate, would
 * produce a number that looks authoritative and is not.
 *
 * @param flavorId A flavour identifier from the catalog.
 * @returns The monthly figure, or 0 when the flavour has no price.
 */
export function priceFor(flavorId: string): number {
  return FLAVOR_PRICES[flavorId] ?? 0;
}

/** Whether a flavour has been priced, so the UI can distinguish "free" from "unknown". */
export function isPriced(flavorId: string): boolean {
  return flavorId in FLAVOR_PRICES;
}

/**
 * The hostname suggested for a new instance.
 *
 * RFC 1123, which the API enforces at 63 characters: lower case, digits and hyphens, starting and
 * ending alphanumeric. The suffix keeps repeated creates from colliding.
 *
 * @param imageId The chosen image, for a recognisable prefix.
 * @returns A valid hostname.
 */
export function suggestedHostname(imageId: string): string {
  const stem = imageId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${stem || 'server'}-${suffix}`;
}
