/**
 * Approximate suburb centres for NSW fleet delivery points.
 *
 * The waybill carries a city name but no coordinates, and "nearby customers
 * share a truck" needs a distance. These are suburb centres to roughly a
 * kilometre — good enough to tell Penrith from Kogarah, not to route a truck
 * street by street. A city missing from this table still plans: it shares a
 * truck only with the same city, or with its own delivery zone.
 *
 * Add a city by its name as the export spells it (case and spacing do not
 * matter). Misspellings seen in the export are mapped in `CITY_ALIASES`.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const LOCATIONS: Record<string, [number, number]> = {
  // Sydney inner and city
  SYDNEY: [-33.869, 151.209],
  ANNANDALE: [-33.881, 151.17],
  'CONCORD WEST': [-33.848, 151.087],
  KENSINGTON: [-33.905, 151.222],
  PADDINGTON: [-33.884, 151.231],
  PARRAMATTA: [-33.815, 151.001],
  RANDWICK: [-33.914, 151.241],
  MARRICKVILLE: [-33.911, 151.155],
  // Sydney south and south-west
  AUBURN: [-33.849, 151.033],
  AUSTRAL: [-33.928, 150.81],
  BANKSTOWN: [-33.918, 151.035],
  BELMORE: [-33.917, 151.088],
  BIRRONG: [-33.892, 151.022],
  BURRANEER: [-34.057, 151.137],
  'CHIPPING NORTON': [-33.917, 150.96],
  CANTERBURY: [-33.912, 151.118],
  CHULLORA: [-33.893, 151.056],
  'CONDELL PARK': [-33.925, 151.011],
  'GRAYS POINT': [-34.058, 151.084],
  GUILDFORD: [-33.853, 150.985],
  'KEMPS CREEK': [-33.879, 150.789],
  KINGSGROVE: [-33.94, 151.1],
  KOGARAH: [-33.963, 151.133],
  LIVERPOOL: [-33.92, 150.924],
  'MACQUARIE FIELDS': [-33.993, 150.892],
  MINTO: [-34.03, 150.846],
  OATLEY: [-33.98, 151.077],
  'ORAN PARK': [-34.006, 150.739],
  PRESTONS: [-33.942, 150.872],
  REVESBY: [-33.95, 151.015],
  SMITHFIELD: [-33.853, 150.94],
  // Sydney north and west
  ARCADIA: [-33.618, 151.043],
  BALGOWLAH: [-33.794, 151.262],
  BIDWILL: [-33.73, 150.822],
  'CAMBRIDGE PARK': [-33.748, 150.723],
  CARLINGFORD: [-33.783, 151.049],
  CASTLEREAGH: [-33.668, 150.678],
  DURAL: [-33.683, 151.028],
  'EMU PLAINS': [-33.749, 150.668],
  'ERSKINE PARK': [-33.813, 150.795],
  HUNTINGWOOD: [-33.795, 150.881],
  MOSMAN: [-33.829, 151.244],
  NARRABEEN: [-33.713, 151.297],
  NORMANHURST: [-33.721, 151.097],
  'NORTH KELLYVILLE': [-33.69, 150.94],
  'NORTH SYDNEY': [-33.839, 151.207],
  NORTHMEAD: [-33.784, 150.995],
  PENRITH: [-33.751, 150.694],
  PLUMPTON: [-33.752, 150.84],
  RICHMOND: [-33.598, 150.751],
  RIVERSTONE: [-33.676, 150.861],
  'ROOTY HILL': [-33.771, 150.844],
  RYDE: [-33.815, 151.104],
  'SEVEN HILLS': [-33.775, 150.937],
  'SOUTH PENRITH': [-33.772, 150.695],
  'ST CLAIR': [-33.797, 150.787],
  TOONGABBIE: [-33.787, 150.951],
  WERRINGTON: [-33.758, 150.749],
  'WEST RYDE': [-33.807, 151.09],
  // Hunter, Central Coast and north
  BALLINA: [-28.866, 153.565],
  BANGALOW: [-28.687, 153.524],
  BELMONT: [-33.036, 151.66],
  BOWRAVILLE: [-30.65, 152.851],
  BROADMEADOW: [-32.924, 151.734],
  COORANBONG: [-33.075, 151.453],
  'GILLIESTON HEIGHTS': [-32.763, 151.528],
  LISMORE: [-28.813, 153.277],
  'MEREWETHER HEIGHTS': [-32.95, 151.73],
  NARRABRI: [-30.325, 149.783],
  RUTHERFORD: [-32.715, 151.533],
  WALLSEND: [-32.902, 151.668],
  // Illawarra, Southern Highlands, ACT and south
  BEGA: [-36.674, 149.842],
  BRUCE: [-35.244, 149.093],
  DAPTO: [-34.493, 150.794],
  GARRAN: [-35.342, 149.108],
  GOOGONG: [-35.415, 149.234],
  'MOSS VALE': [-34.548, 150.371],
  PICTON: [-34.17, 150.611],
  TAHMOOR: [-34.222, 150.593],
  TUMUT: [-35.3, 148.224],
  WILTON: [-34.24, 150.697],
  WIRLINGA: [-36.035, 146.968],
};

/** Spellings the export has used, mapped to the table's name. */
const CITY_ALIASES: Record<string, string> = {
  RANWICK: 'RANDWICK',
  'RYDE NSW': 'RYDE',
  'HIGH STREET, KENSINGTON': 'KENSINGTON',
};

/** Upper case, single spaces, non-breaking spaces treated as spaces. */
export const normalizeCity = (city: string): string =>
  city.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

export function locate(city: string): LatLon | null {
  const key = normalizeCity(city);
  const hit = LOCATIONS[CITY_ALIASES[key] ?? key];
  return hit ? { lat: hit[0], lon: hit[1] } : null;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
