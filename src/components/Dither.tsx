import { useEffect, useRef } from "react";

const vert = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const frag = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseRadius;
uniform vec3 uColor;
uniform float uColorIntensity;
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveSpeed;

float bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  if(x==0&&y==0) return 0.0/16.0;
  if(x==1&&y==0) return 8.0/16.0;
  if(x==2&&y==0) return 2.0/16.0;
  if(x==3&&y==0) return 10.0/16.0;
  if(x==0&&y==1) return 12.0/16.0;
  if(x==1&&y==1) return 4.0/16.0;
  if(x==2&&y==1) return 14.0/16.0;
  if(x==3&&y==1) return 6.0/16.0;
  if(x==0&&y==2) return 3.0/16.0;
  if(x==1&&y==2) return 11.0/16.0;
  if(x==2&&y==2) return 1.0/16.0;
  if(x==3&&y==2) return 9.0/16.0;
  if(x==0&&y==3) return 15.0/16.0;
  if(x==1&&y==3) return 7.0/16.0;
  if(x==2&&y==3) return 13.0/16.0;
  return 5.0/16.0;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i+vec2(1,0)), u.x),
    mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x),
    u.y
  );
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Mouse interaction — push waves away from cursor
  vec2 mouseUV = uMouse / uResolution;
  mouseUV.y = 1.0 - mouseUV.y;
  float mouseDist = length(uv - mouseUV);
  float mouseInfluence = smoothstep(uMouseRadius, 0.0, mouseDist) * 0.4;

  // Wave distortion
  float t = uTime * uWaveSpeed;
  float wave =
    sin(uv.x * uWaveFreq + t) * uWaveAmp +
    sin(uv.y * uWaveFreq * 0.8 + t * 1.2) * uWaveAmp * 0.6 +
    mouseInfluence;

  vec2 warpedUV = uv + vec2(wave * 0.4, wave);

  // Multi-octave noise
  float n =
    noise(warpedUV * 3.0 + t * 0.5) +
    0.5 * noise(warpedUV * 6.0 - t * 0.7) +
    0.25 * noise(warpedUV * 12.0 + t);
  n /= 1.75;
  n = clamp(n * uColorIntensity * 0.25, 0.0, 1.0);

  // Bayer dithering
  float threshold = bayer(gl_FragCoord.xy);
  float dithered = step(threshold, n);

  gl_FragColor = vec4(uColor * dithered, 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

export default function Dither() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = canvas.getContext("webgl")!;
    if (!gl) return;

    const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const uRes   = gl.getUniformLocation(prog, "uResolution");
    const uTime  = gl.getUniformLocation(prog, "uTime");
    const uMouse = gl.getUniformLocation(prog, "uMouse");
    const uMouseR= gl.getUniformLocation(prog, "uMouseRadius");
    const uColor = gl.getUniformLocation(prog, "uColor");
    const uCI    = gl.getUniformLocation(prog, "uColorIntensity");
    const uAmp   = gl.getUniformLocation(prog, "uWaveAmp");
    const uFreq  = gl.getUniformLocation(prog, "uWaveFreq");
    const uSpeed = gl.getUniformLocation(prog, "uWaveSpeed");

    // Settings from image
    gl.uniform3f(uColor, 0.5, 0.5, 0.5);
    gl.uniform1f(uCI, 4.0);
    gl.uniform1f(uAmp, 0.3);
    gl.uniform1f(uFreq, 3.0);
    gl.uniform1f(uSpeed, 0.05);
    gl.uniform1f(uMouseR, 0.3);

    let mouseX = 0, mouseY = 0;
    const onMouse = (e: MouseEvent) => { mouseX = e.clientX; mouseY = e.clientY; };
    window.addEventListener("mousemove", onMouse);

    let raf: number;
    const start = performance.now();

    function resize() {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    function render() {
      raf = requestAnimationFrame(render);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    render();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMouse);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", zIndex: 0, pointerEvents: "none", opacity: 0.4, mixBlendMode: "screen" }}
    />
  );
}