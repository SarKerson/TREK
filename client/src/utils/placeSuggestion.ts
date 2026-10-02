export interface PlaceSuggestion {
  placeId: string
  mainText: string
  secondaryText: string
  source?: string
  lat?: number
  lng?: number
}

/** A lookup failure must not turn the selected station into the first nearby shop. */
export function placeFromSuggestion(suggestion: PlaceSuggestion): Record<string, unknown> | null {
  const { lat, lng, placeId, mainText, source } = suggestion
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const idField = placeId.startsWith('amap:') ? 'amap_poi_id'
    : /^(gers|node|way|relation):/.test(placeId) ? 'osm_id' : 'google_place_id'
  return { name: mainText, address: '', lat, lng, [idField]: placeId, source }
}

/** Text search is only an automatic fallback when it found the very same provider record. */
export function matchingSuggestionPlace(
  suggestion: PlaceSuggestion,
  places: Record<string, unknown>[] = [],
): Record<string, unknown> | null {
  return places.find(place => (
    place.lat != null && place.lng != null &&
    ['google_place_id', 'osm_id', 'amap_poi_id'].some(field => place[field] === suggestion.placeId)
  )) ?? null
}
