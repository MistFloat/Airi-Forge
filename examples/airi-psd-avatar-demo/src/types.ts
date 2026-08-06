export type LayerRole = 'body' | 'brow' | 'eye' | 'hair' | 'head' | 'mouth'

export interface PsdLayerAsset {
  dataUrl: string
  height: number
  left: number
  name: string
  role: LayerRole
  top: number
  width: number
  zIndex: number
}

export interface PsdRig {
  height: number
  layers: PsdLayerAsset[]
  width: number
}
