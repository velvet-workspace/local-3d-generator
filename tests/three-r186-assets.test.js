import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createApp} from "../server/index.js";

test("r186 GLTFLoader dependencies remain explicit local-only vendor assets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "three-r186-http-"));
  const app = await createApp({dataDir: path.join(tmp,"data"), fixtureFile: path.join(tmp,"model.glb"),stepMs:30});
  try {
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const host = "http://127.0.0.1:"+app.server.address().port;
    for (const name of ["SkeletonUtils.js", "BufferGeometryUtils.js"]) {
      const response = await fetch(host + "/vendor/three/examples/jsm/utils/" + name);
      assert.equal(response.status,200,name+" must resolve from installed three package");
      assert.match(response.headers.get("content-type") || "",/javascript/);
      const body = await response.text();
      assert.ok(body.includes("import") || body.includes("export"), "asset should be an ESM module");
    }
    const unlisted = await fetch(host+"/vendor/three/examples/jsm/utils/unlisted.js");
    assert.equal(unlisted.status,404);
    const attack = await fetch(host+"/vendor/three/examples/jsm/utils/..%2F..%2Fsecret.txt");
    assert.notEqual(attack.status,200);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(tmp,{recursive:true,force:true});
  }
});
