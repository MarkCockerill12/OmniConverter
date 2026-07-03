import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";

import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

/**
 * Headless 3D Model Converter
 * Loads 3D files in memory using official loaders and exports them cleanly using core exporters.
 * This runs entirely on the client-side (browser) and is decoupled from the active WebGL Viewport.
 */
export async function convert3DModelHeadless(file: File, targetFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const lowerTarget = targetFormat.toLowerCase();

  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager();
    const url = URL.createObjectURL(file);

    const onLoad = (object: THREE.Object3D | THREE.Group | any) => {
      URL.revokeObjectURL(url);

      // Extract the scene object if wrapped inside loaders (like GLTF or Collada)
      let sceneObject = object;
      if (object && object.scene) {
        sceneObject = object.scene;
      }

      if (lowerTarget === 'obj') {
        try {
          const exporter = new OBJExporter();
          const result = exporter.parse(sceneObject);
          resolve(new Blob([result], { type: 'text/plain' }));
        } catch (err) {
          reject(err);
        }
      } else if (lowerTarget === 'stl') {
        try {
          const exporter = new STLExporter();
          const result = exporter.parse(sceneObject, { binary: true });
          resolve(new Blob([result], { type: 'application/octet-stream' }));
        } catch (err) {
          reject(err);
        }
      } else if (lowerTarget === 'glb' || lowerTarget === 'gltf') {
        try {
          const exporter = new GLTFExporter();
          const isBinary = lowerTarget === 'glb';
          exporter.parse(sceneObject, (result) => {
            const blob = new Blob([isBinary ? result as any : JSON.stringify(result)], { 
              type: isBinary ? 'model/gltf-binary' : 'application/json' 
            });
            resolve(blob);
          }, (err) => reject(err), { binary: isBinary, includeCustomExtensions: true });
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`Unsupported export target format: ${targetFormat}`));
      }
    };

    const onError = (err: any) => {
      URL.revokeObjectURL(url);
      reject(err || new Error("Failed to parse 3D file."));
    };

    // Load source file based on extension
    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader(manager);
      loader.load(url, onLoad, undefined, onError);
    } else if (ext === 'obj') {
      const loader = new OBJLoader(manager);
      loader.load(url, onLoad, undefined, onError);
    } else if (ext === 'stl') {
      const loader = new STLLoader(manager);
      loader.load(url, (geometry) => {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
        onLoad(mesh);
      }, undefined, onError);
    } else if (ext === 'fbx') {
      const loader = new FBXLoader(manager);
      loader.load(url, onLoad, undefined, onError);
    } else if (ext === 'dae') {
      const loader = new ColladaLoader(manager);
      loader.load(url, onLoad, undefined, onError);
    } else {
      reject(new Error(`3D Conversion from .${ext?.toUpperCase()} not supported.`));
    }
  });
}
