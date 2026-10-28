// Optional browser-only studio environment, adapted from:
// https://github.com/blendi-remade/dioramas/blob/main/src/core/engine.js
// Dioramas (c) 2026 Blendi, MIT; see docs/licenses/dioramas-MIT.txt.
// All geometry here is lighting-only and never changes a loaded model or output GLB.
import * as THREE from 'three';

export function createStudioPreview(renderer, scene) {
  const baseline = {
    environment: scene.environment,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
  };
  let target = null;
  let enabled = false;

  function buildEnvironment() {
    const studio = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(20, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          top: { value: new THREE.Color(0x242d37) },
          bottom: { value: new THREE.Color(0x090d12) },
        },
        vertexShader: `varying vec3 vP;
          void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
          void main() { gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.4, 0.8, vP.y)), 1.0); }`,
      }),
    );
    studio.add(dome);
    const panels = [
      { position: [0, 7, 5], size: [8, 3], intensity: 5.2, color: 0xffffff },
      { position: [-6, 2, -3], size: [3, 5], intensity: 3.2, color: 0xfff2e6 },
      { position: [6, 3, -1], size: [2, 6], intensity: 2.8, color: 0xddefff },
    ];
    for (const panel of panels) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(...panel.size),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(panel.color).multiplyScalar(panel.intensity),
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      mesh.position.set(...panel.position);
      mesh.lookAt(0, 0, 0);
      studio.add(mesh);
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      return pmrem.fromScene(studio, 0.04);
    } finally {
      pmrem.dispose();
      studio.traverse(object => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
    }
  }

  function setEnabled(nextEnabled) {
    if (nextEnabled && !target) target = buildEnvironment();
    enabled = !!nextEnabled;
    scene.environment = enabled ? target.texture : baseline.environment;
    renderer.toneMapping = enabled ? THREE.ACESFilmicToneMapping : baseline.toneMapping;
    renderer.toneMappingExposure = enabled ? 1.2 : baseline.exposure;
    return enabled;
  }

  function dispose() {
    setEnabled(false);
    target?.dispose();
    target = null;
  }

  return { setEnabled, dispose, get enabled() { return enabled; } };
}
