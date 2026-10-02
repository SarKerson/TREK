import { describe, it, expect } from 'vitest'
import { DEFAULT_FORM, clearProviderDetails, changePlaceFormField, mergeResult, isAmapUrl, isGoogleMapsUrl, isMapUrl } from './PlaceFormModal.helpers'

describe('isGoogleMapsUrl', () => {
  it('accepts the short share hosts', () => {
    expect(isGoogleMapsUrl('https://maps.app.goo.gl/abc123')).toBe(true)
    expect(isGoogleMapsUrl('https://goo.gl/maps/xyz')).toBe(true)
  })

  it('rejects goo.gl links that are not /maps', () => {
    expect(isGoogleMapsUrl('https://goo.gl/something')).toBe(false)
  })

  it('accepts maps.google.<tld> and maps.google.<sld>.<tld>', () => {
    expect(isGoogleMapsUrl('https://maps.google.com/?q=eiffel')).toBe(true)
    expect(isGoogleMapsUrl('https://maps.google.co.uk/?q=eiffel')).toBe(true)
  })

  it('accepts google.<tld>/maps with optional www', () => {
    expect(isGoogleMapsUrl('https://google.com/maps/place/Eiffel')).toBe(true)
    expect(isGoogleMapsUrl('https://www.google.co.uk/maps')).toBe(true)
  })

  it('rejects google.<tld> without a /maps path', () => {
    expect(isGoogleMapsUrl('https://google.com/search?q=eiffel')).toBe(false)
  })

  it('rejects spoofed hosts like maps.google.evil.com', () => {
    expect(isGoogleMapsUrl('https://maps.google.evil.com/maps')).toBe(false)
  })

  it('returns false for non-URL input', () => {
    expect(isGoogleMapsUrl('not a url')).toBe(false)
    expect(isGoogleMapsUrl('')).toBe(false)
    expect(isGoogleMapsUrl('Eiffel Tower')).toBe(false)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(isGoogleMapsUrl('  https://maps.app.goo.gl/abc123  ')).toBe(true)
  })
})

describe('isAmapUrl', () => {
  it('accepts the share, web and short-link hosts', () => {
    expect(isAmapUrl('https://uri.amap.com/marker?position=116.397,39.908&name=天安门')).toBe(true)
    expect(isAmapUrl('https://www.amap.com/place/B000A7BD6C')).toBe(true)
    expect(isAmapUrl('https://surl.amap.com/abc')).toBe(true)
  })

  it('is an exact host list, so a lookalike stays a search query', () => {
    expect(isAmapUrl('https://amap.com.evil.example/place/x')).toBe(false)
    expect(isAmapUrl('https://restapi.amap.com/v3/place/text')).toBe(false)
    expect(isAmapUrl('天安门')).toBe(false)
  })
})

describe('isMapUrl', () => {
  it('sends either provider\'s link to the resolver and nothing else', () => {
    expect(isMapUrl('https://maps.app.goo.gl/abc123')).toBe(true)
    expect(isMapUrl('https://uri.amap.com/marker?position=116.397,39.908')).toBe(true)
    expect(isMapUrl('https://example.com/maps')).toBe(false)
  })
})


describe('saved provider identity', () => {
  it('explicitly clears persisted identities and phone omitted by a replacement pick', () => {
    const form = { ...DEFAULT_FORM, name: 'Nankai Station', notes: 'Meet at the gates',
      website: 'https://my-trip.example', google_place_id: 'old-shop', google_ftid: 'old-ftid',
      osm_id: 'node:1', amap_poi_id: 'amap:old', phone: '+81-old-shop' }
    const next = mergeResult(form, { name: 'Namba', lat: 34.665, lng: 135.501, osm_id: 'node:2' }, new Set())
    expect(next).toMatchObject({ google_place_id: '', google_ftid: '', amap_poi_id: '', phone: '',
      osm_id: 'node:2', notes: form.notes, website: form.website })
  })
})


describe('manual provider cleanup', () => {
  const saved = { ...DEFAULT_FORM, name: 'Our station', lat: '34.665', lng: '135.501',
    website: 'https://mine.example', description: 'Our meeting point', notes: 'Meet at gates',
    google_place_id: 'old-shop', phone: '+81-shop' }
  it('keeps all user fields and coordinates, and explicitly clears every hidden linked field', () => {
    expect(clearProviderDetails(saved)).toEqual({ ...saved, google_place_id: '', google_ftid: '', osm_id: '', amap_poi_id: '', phone: '' })
  })
  it('preserves an identity for unrelated edits or unchanged coordinates', () => {
    expect(changePlaceFormField(saved, 'lat', saved.lat)).toEqual(saved)
    expect(changePlaceFormField(saved, 'notes', 'New note')).toEqual({ ...saved, notes: 'New note' })
  })
})
