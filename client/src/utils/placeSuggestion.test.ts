import { describe, expect, it } from 'vitest'
import { matchingSuggestionPlace, placeFromSuggestion } from './placeSuggestion'

const suggestion = { placeId: 'gers:station', mainText: 'Nankai Station', secondaryText: 'Namba', source: 'trek-places', lat: 34.665, lng: 135.501 }

describe('autocomplete identity fallback', () => {
  it.each([['gers:station', 'osm_id'], ['node:2', 'osm_id'], ['amap:station', 'amap_poi_id'], ['ChIJstation', 'google_place_id']])('preserves %s without looking up a different place', (placeId, field) => {
    expect(placeFromSuggestion({ ...suggestion, placeId })).toEqual({ name: suggestion.mainText, address: '', lat: suggestion.lat, lng: suggestion.lng, [field]: placeId, source: suggestion.source })
  })
  it('cannot manufacture coordinates, but keeps valid zero coordinates', () => {
    expect(placeFromSuggestion({ ...suggestion, lat: undefined })).toBeNull()
    expect(placeFromSuggestion({ ...suggestion, lng: NaN })).toBeNull()
    expect(placeFromSuggestion({ ...suggestion, lat: 0, lng: 0 })).toMatchObject({ lat: 0, lng: 0 })
  })
  it('requires the original identity rather than taking the top result or a similar name', () => {
    const shop = { name: 'Nankai Station', osm_id: 'gers:shop', lat: 34.665, lng: 135.501 }
    const station = { ...shop, osm_id: suggestion.placeId }
    expect(matchingSuggestionPlace(suggestion, [shop])).toBeNull()
    expect(matchingSuggestionPlace(suggestion, [{ ...station, lat: null }])).toBeNull()
    expect(matchingSuggestionPlace(suggestion, [shop, station])).toBe(station)
    expect(matchingSuggestionPlace(suggestion)).toBeNull()
  })
})
