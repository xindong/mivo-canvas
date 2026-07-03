import { Buffer } from 'node:buffer'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const eagleMockItemId = 'E2E-EAGLE-ASSET'
const localAssetFixtureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72" viewBox="0 0 96 72">
  <rect width="96" height="72" rx="10" fill="#fffaf0"/>
  <circle cx="34" cy="36" r="18" fill="#6957e8"/>
  <path d="M48 18l22 36H26z" fill="#ff8a00" fill-opacity=".82"/>
</svg>`
const eagleMockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">
  <rect width="120" height="90" rx="12" fill="#f4efe6"/>
  <rect x="18" y="18" width="84" height="54" rx="8" fill="#6957e8"/>
  <circle cx="60" cy="45" r="18" fill="#ff8a00"/>
</svg>`
const horizontalMaskSourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <rect width="1600" height="900" fill="#2767c8"/>
  <rect x="520" y="260" width="560" height="320" rx="48" fill="#ffd35a"/>
  <circle cx="800" cy="420" r="120" fill="#26a269"/>
</svg>`

export const prepareSmokeFixtures = () => {
  const localAssetFixtureDir = path.resolve('test-artifacts/local-assets')
  const eagleMockDir = path.resolve('test-artifacts/eagle-mock')
  const eagleMockItemDir = path.join(eagleMockDir, `${eagleMockItemId}.info`)

  mkdirSync(localAssetFixtureDir, { recursive: true })
  mkdirSync(eagleMockItemDir, { recursive: true })
  writeFileSync(path.join(localAssetFixtureDir, 'mivo-local-fixture.svg'), localAssetFixtureSvg)
  writeFileSync(path.join(eagleMockItemDir, 'Mock Eagle Concept.svg'), eagleMockSvg)
  writeFileSync(path.join(eagleMockItemDir, 'Mock Eagle Concept_thumbnail.svg'), eagleMockSvg)

  const now = Date.now()

  return {
    eagleMockDir,
    eagleMockItem: {
      id: eagleMockItemId,
      name: 'Mock Eagle Concept',
      size: Buffer.byteLength(eagleMockSvg),
      btime: now,
      mtime: now,
      ext: 'svg',
      tags: ['mock', 'eagle'],
      folders: ['MOCK-FOLDER'],
      isDeleted: false,
      url: 'https://example.com/mock-eagle-concept',
      annotation: 'Mock Eagle metadata note',
      modificationTime: now,
      height: 90,
      width: 120,
    },
    eagleMockItemDir,
    generatedImageB64: `data:image/jpeg;base64,${readFileSync(path.resolve('public/demo-assets/courage-1.jpg')).toString('base64')}`,
    horizontalMaskSourceB64: `data:image/svg+xml;base64,${Buffer.from(horizontalMaskSourceSvg).toString('base64')}`,
    localAssetFixtureDir,
    localAssetFixtureSvg,
  }
}
