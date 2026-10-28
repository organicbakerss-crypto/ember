import { describe, expect, it } from 'vitest'
import type { MapFile, Point } from '../schema'
import {
  labelPoint,
  nearbyPlaces,
  pointInRegion,
  regionAdjacency,
  regionPath,
  regionTemplate,
  smallestRegionAt,
} from './maps'

const square = (x: number, y: number, w: number, h = w): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
]
// Three regions in a row across a 1000 × 400 image, with 6px border lines between
// a and b; c is far from a.
const a = { id: 'a', rings: [square(0, 0, 300, 400)] }
const b = { id: 'b', rings: [square(306, 0, 300, 400)] }
const c = { id: 'c', rings: [square(700, 0, 300, 400)] }

describe('region adjacency', () => {
  it('finds regions that touch across a border line, not distant ones', () => {
    const pairs = regionAdjacency([a, b, c], 1000, 400).map((p) => p.sort().join('-'))
    expect(pairs).toEqual(['a-b'])
  })

  it('turns touching regions and sketch roads into nearby places', () => {
    const map = {
      image: { file: 'x', width: 1000, height: 400 },
      regions: [
        { ...a, placeId: 'ent_a' },
        { ...b, placeId: 'ent_b' },
        { ...c, placeId: null },
      ],
      sketch: null,
    } as unknown as MapFile
    const sketch = {
      image: null,
      regions: [],
      sketch: { nodes: [], roads: [{ from: 'ent_b', to: 'ent_x' }] },
    } as unknown as MapFile
    const nearby = nearbyPlaces([map, sketch])
    expect(nearby['ent_a']).toEqual(['ent_b'])
    expect(nearby['ent_b']!.sort()).toEqual(['ent_a', 'ent_x'])
  })
})

describe('pins', () => {
  it('counts pins close together as nearby, and finds the smallest region at a point', () => {
    const map = {
      image: { file: 'x', width: 1000, height: 400 },
      regions: [],
      pins: [
        { id: 'p1', placeId: 'ent_a', x: 100, y: 100 },
        { id: 'p2', placeId: 'ent_b', x: 130, y: 100 },
        { id: 'p3', placeId: 'ent_c', x: 600, y: 300 },
      ],
      sketch: null,
    } as unknown as MapFile
    const nearby = nearbyPlaces([map])
    expect(nearby['ent_a']).toEqual(['ent_b'])
    expect(nearby['ent_c']).toBeUndefined()
    const big = { id: 'big', rings: [square(0, 0, 500)] }
    const small = { id: 'small', rings: [square(50, 50, 100)] }
    expect(smallestRegionAt([big, small], [80, 80])?.id).toBe('small')
    expect(smallestRegionAt([big, small], [300, 300])?.id).toBe('big')
    expect(smallestRegionAt([big, small], [700, 300])).toBeUndefined()
  })
})

describe('region geometry', () => {
  it('treats holes as outside', () => {
    const ring = { rings: [square(0, 0, 100), square(40, 40, 20)] }
    expect(pointInRegion([10, 10], ring)).toBe(true)
    expect(pointInRegion([50, 50], ring)).toBe(false)
    expect(regionPath(ring)).toBe('M0,0L100,0L100,100L0,100ZM40,40L60,40L60,60L40,60Z')
  })

  it('places a label inside even an odd shape', () => {
    expect(labelPoint({ rings: [square(0, 0, 100)] })).toEqual([50, 50])
    const crescent: Point[] = [
      [0, 0],
      [100, 0],
      [100, 10],
      [10, 10],
      [10, 90],
      [100, 90],
      [100, 100],
      [0, 100],
    ]
    expect(pointInRegion(labelPoint({ rings: [crescent] }), { rings: [crescent] })).toBe(true)
  })

  it('guesses the kind of place for a new region from the map', () => {
    expect(regionTemplate(null)).toBe('kingdom')
    expect(regionTemplate('city')).toBe('district')
    expect(regionTemplate('kingdom')).toBe('city')
  })
})
