import * as THREE from 'three';
import { MDL0Model } from './wii-parser';

/**
 * Three.js Loader for Nintendo Wii MDL0 models.
 * Offloads heavy binary parsing to the NintendoWorker.
 */
export class WiiLoader extends THREE.Loader {
    private worker: Worker | null = null;

    constructor(manager?: THREE.LoadingManager, worker?: Worker | null) {
        super(manager);
        this.worker = worker || null;
    }

    load(url: string, onLoad: (group: THREE.Group) => void, onProgress?: (event: ProgressEvent) => void, onError?: (event: ErrorEvent) => void) {
        const loader = new THREE.FileLoader(this.manager);
        loader.setPath(this.path);
        loader.setResponseType('arraybuffer');
        loader.setRequestHeader(this.requestHeader);
        loader.setWithCredentials(this.withCredentials);

        loader.load(url, async (buffer) => {
            try {
                const group = await this.parse(buffer as ArrayBuffer, url.split('/').pop() || "model");
                onLoad(group);
            } catch (e) {
                if (onError) onError(e as ErrorEvent);
                else console.error(e);
            }
        }, onProgress, onError);
    }

    async parse(buffer: ArrayBuffer, name: string = "model"): Promise<THREE.Group> {
        let modelData: MDL0Model;

        if (this.worker) {
            // Use background worker for parsing with a correlation ID
            const requestId = Math.random().toString(36).substring(2, 9);
            modelData = await new Promise((resolve, reject) => {
                const handler = (e: MessageEvent) => {
                    if (e.data.requestId !== requestId) return;
                    if (e.data.type === 'PARSE_MDL0_SUCCESS') {
                        this.worker?.removeEventListener('message', handler);
                        resolve(e.data.payload.modelData);
                    } else if (e.data.type === 'PARSE_MDL0_ERROR') {
                        this.worker?.removeEventListener('message', handler);
                        reject(new Error(e.data.payload.error));
                    }
                };
                this.worker?.addEventListener('message', handler);
                this.worker?.postMessage({ type: 'PARSE_MDL0', requestId, payload: { buffer, name } }, [buffer]);
            });
        } else {
            // Fallback to main thread (not recommended for large models)
            const { parseMDL0 } = await import('./wii-parser');
            modelData = parseMDL0(buffer, name);
        }

        const group = new THREE.Group();
        group.name = modelData.name;

        modelData.nodes.forEach(node => {
            const geoData = modelData.geometries[node.geometryIdx];
            if (!geoData) return;

            const geometry = new THREE.BufferGeometry();
            
            if (geoData.attributes.position) {
                geometry.setAttribute('position', new THREE.BufferAttribute(geoData.attributes.position, 3));
            }
            
            if (geoData.attributes.uv) {
                geometry.setAttribute('uv', new THREE.BufferAttribute(geoData.attributes.uv, 2));
            }

            if (geoData.indices && geoData.indices.length > 0) {
                geometry.setIndex(new THREE.BufferAttribute(geoData.indices, 1));
            }
            
            geometry.computeVertexNormals();

            // Resolve material information
            let materialName = node.name;
            let wrapS = THREE.RepeatWrapping;
            let wrapT = THREE.RepeatWrapping;

            if (node.materialIdx !== undefined && modelData.materials[node.materialIdx]) {
                const matInfo = modelData.materials[node.materialIdx];
                // Use the Material Name for heuristic matching if available, otherwise fallback to texture name
                materialName = matInfo.name;
                
                const mapWrap = (w: number) => {
                    if (w === 0) return THREE.ClampToEdgeWrapping;
                    if (w === 2) return THREE.MirroredRepeatWrapping;
                    return THREE.RepeatWrapping;
                };
                wrapS = mapWrap(matInfo.wrapS);
                wrapT = mapWrap(matInfo.wrapT);
            }

            const material = new THREE.MeshStandardMaterial({
                side: THREE.DoubleSide,
                color: 0xffffff,
                roughness: 0.8,
                metalness: 0.2,
                name: materialName
            });

            // If we have a texture name, we can store it in userData for the viewer to find it more easily
            if (node.materialIdx !== undefined && modelData.materials[node.materialIdx]) {
                const matInfo = modelData.materials[node.materialIdx];
                material.userData.wiiTextureName = matInfo.texture;
                material.userData.wrapS = wrapS;
                material.userData.wrapT = wrapT;
            }

            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = node.name;
            group.add(mesh);
        });

        return group;
    }
}
