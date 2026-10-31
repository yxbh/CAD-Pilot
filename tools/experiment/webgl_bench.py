"""Experiment only: how fast each ANGLE backend draws a heavy WebGL2 scene on this machine."""
import json
import sys
import time

from playwright.sync_api import sync_playwright

PAGE = """
<canvas id=c width=1248 height=920></canvas>
<script>
const gl = document.getElementById('c').getContext('webgl2', {antialias: true});
window.info = gl ? (() => { const e = gl.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() : null;
window.bench = (frames) => {
  const vs = `#version 300 es
  in vec2 p; out vec3 n; uniform float t;
  void main(){ float z = sin(p.x*20.0+t)*cos(p.y*20.0); n = normalize(vec3(-cos(p.x*20.0+t), sin(p.y*20.0), 1.0));
  gl_Position = vec4(p*1.8-0.9, z*0.1, 1.0); }`;
  const fs = `#version 300 es
  precision highp float; in vec3 n; out vec4 o; uniform float t;
  void main(){ vec3 c = vec3(0.0); for (int i = 0; i < 48; i++) { float a = float(i)*0.13+t;
    vec3 l = normalize(vec3(cos(a), sin(a), 1.0)); c += max(dot(n,l),0.0)*vec3(0.02,0.021,0.019) + pow(max(dot(reflect(-l,n),vec3(0,0,1)),0.0),32.0)*0.01; }
    o = vec4(c,1.0); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  const N = 300, v = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const a=i/N,b=j/N,c=(i+1)/N,d=(j+1)/N; v.push(a,b,c,b,a,d, c,b,c,d,a,d); }
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enable(gl.DEPTH_TEST);
  const tl = gl.getUniformLocation(prog, 't'); const px = new Uint8Array(4);
  const start = performance.now();
  for (let f = 0; f < frames; f++) { gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.uniform1f(tl, f*0.1);
    gl.drawArrays(gl.TRIANGLES, 0, v.length/2); gl.readPixels(600, 400, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  return (performance.now() - start) / frames;
};
</script>"""

CANDIDATES = {
    "darwin": [[], ["--use-angle=metal"]],
    "win32": [[], ["--use-angle=d3d11"], ["--use-angle=d3d11-warp"], ["--use-angle=d3d11", "--disable-gpu-driver-bug-workarounds"]],
    "linux": [[], ["--use-angle=gl"], ["--use-angle=vulkan"], ["--use-gl=egl"]],
}[sys.platform]

with sync_playwright() as playwright:
    for args in CANDIDATES:
        started = time.perf_counter()
        try:
            browser = playwright.chromium.launch(args=args)
            page = browser.new_page()
            page.set_content(PAGE)
            info = page.evaluate("window.info")
            ms = page.evaluate("window.bench(3)") and page.evaluate("window.bench(20)") if info else None
            browser.close()
            print(json.dumps({"platform": sys.platform, "args": args, "renderer": info, "msPerFrame": ms, "launchToEnd": round(time.perf_counter() - started, 2)}), flush=True)
        except Exception as error:
            print(json.dumps({"platform": sys.platform, "args": args, "error": str(error)[:300]}), flush=True)
