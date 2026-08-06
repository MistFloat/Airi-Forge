import type { Layer } from 'ag-psd'

import type { LayerRole, PsdLayerAsset, PsdRig } from '../types'

import { readPsd } from 'ag-psd'

const eyeNames = ['eyewhite', 'irides', 'eyelash']
const headNames = ['face', 'nose', 'neck', 'ears', 'headwear']
const hairNames = ['front hair', 'back hair']

/**
 * Reads a Photoshop document into transparent, independently transformable layer images.
 * The source file remains untouched; the resulting data URLs only live for the current browser session.
 */
export async function loadPsdRig(url: string): Promise<PsdRig> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`PSD 读取失败：HTTP ${response.status}`)

  const psd = readPsd(await response.arrayBuffer(), {
    skipCompositeImageData: true,
    skipThumbnail: true,
  })
  const sourceLayers = flattenLayers(psd.children ?? [])

  const layers = sourceLayers.flatMap<PsdLayerAsset>((layer, index) => {
    if (!layer.canvas || layer.hidden)
      return []

    const left = layer.left ?? 0
    const top = layer.top ?? 0
    const width = (layer.right ?? left + layer.canvas.width) - left
    const height = (layer.bottom ?? top + layer.canvas.height) - top
    if (width <= 0 || height <= 0)
      return []

    return [{
      dataUrl: layer.canvas.toDataURL('image/png'),
      height,
      left,
      name: layer.name ?? `layer-${index + 1}`,
      role: resolveLayerRole(layer.name ?? ''),
      top,
      width,
      // ag-psd returns this document from back to front; CSS uses the same paint order.
      zIndex: index + 1,
    }]
  })

  return {
    height: psd.height,
    layers,
    width: psd.width,
  }
}

/**
 * Maps the PSD's material-separation names to the parameter groups used by AIRI's Live2D scene.
 * Unknown layers deliberately stay on the body so clothing additions remain visible without configuration.
 */
export function resolveLayerRole(name: string): LayerRole {
  const normalized = name.trim().toLowerCase()

  if (normalized === 'mouth')
    return 'mouth'
  if (normalized.startsWith('eyebrow'))
    return 'brow'
  if (eyeNames.some(prefix => normalized.startsWith(prefix)))
    return 'eye'
  if (hairNames.includes(normalized))
    return 'hair'
  if (headNames.some(prefix => normalized.startsWith(prefix)))
    return 'head'
  return 'body'
}

function flattenLayers(layers: Layer[], output: Layer[] = []): Layer[] {
  for (const layer of layers) {
    if (layer.children?.length)
      flattenLayers(layer.children, output)
    else
      output.push(layer)
  }
  return output
}
