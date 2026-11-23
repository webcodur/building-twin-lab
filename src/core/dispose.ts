import * as THREE from 'three';

/** 장면 그래프를 돌며 GPU 자원(지오메트리·재질·텍스처)을 반납한다. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) {
        if (v instanceof THREE.Texture) v.dispose();
      }
      m.dispose();
    }
    if (obj instanceof THREE.InstancedMesh) obj.dispose();
  });
}
