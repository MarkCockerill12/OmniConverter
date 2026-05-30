# ULTIMATE_CONTEXT - Omni

## Tech Stack
- **Framework:** Next.js (App Router)
- **3D Engine:** Three.js
- **Model Loaders:** ColladaLoader, GLTFLoader, OBJLoader, STLLoader
- **Utilities:** fflate (unzip), lucide (icons)
- **Styling:** Tailwind CSS, Framer Motion

## Features
- Multi-model 3D Viewer with Model Catalog selection.
- ZIP & SZS (Yaz0/RARC) archive model discovery and texture resolution.
- Advanced Material/Texture mapping for Wii models (DAE).
- GLB Master Export (combining all visible models).

## Progress Ledger
- [2026-05-23] Fixed 3D model texture loading from ZIP archives.
- [2026-05-23] Resolved COLLADA 1.5.0 incompatibility with surgical DAE pre-processing.
- [2026-05-23] Implemented Multi-Model support with internal catalog discovery.
- [2026-05-23] Fixed "Cyclops" forehead eye and "Ghost" transparency via surgical DAE node targeting (`polygon0`, `polygon1`).
- [2026-05-24] Enhanced 3D Loader: Robust '_fix' texture preference for eyes, improved overlay heuristics for mustache/mouth, and resolved missing forehead/transparent eye regressions via surgical alphaTest tuning.
- [2026-05-24] Added native .szs support: Integrated Yaz0 decompression and RARC archive parsing into the discovery loop.
- [2026-05-23] Implemented Master GLB Export for combined models.

## Operational Logic
- **Texture Resolution:** Uses a hierarchical search (Exact -> Category-based -> Fuzzy) to map textures from ZIPs to meshes.
- **DAE Pre-processing:** Strips `<ref>` tags from `<init_from>` blocks in DAE files to support COLLADA 1.5.0.
- **Material Tuning:** Forces body meshes to be opaque (`transparent: false`) and accessory meshes (eyes, mustache) to be transparent overlays with higher `renderOrder`.
- **Z-Fighting:** Uses `polygonOffset` and `renderOrder` to manage layered geometry.

- [2026-05-30] **BrawlLib Reverse-Engineering Success**: Implemented bit-perfect MDL0 parsing with version-aware resource mapping and draw-call material linking. Fixed RangeError crashes and resolved 'wonky' textures by extracting native Wii wrap modes and material names.
