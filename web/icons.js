// Builds the item icon sprite sheet. The game's icon atlases are GPU-compressed (BC7), so the
// server sends them as they are and WebGL decodes them here; each icon is shrunk into its cell
// of one sheet, which goes back to the server as a PNG to be kept on disk.

const GL_FORMATS = {
  bc7: { extension: 'EXT_texture_compression_bptc', internal: 0x8e8c }, // COMPRESSED_RGBA_BPTC_UNORM
  bc3: { extension: 'WEBGL_compressed_texture_s3tc', internal: 0x83f3 }, // COMPRESSED_RGBA_S3TC_DXT5
  bc1: { extension: 'WEBGL_compressed_texture_s3tc', internal: 0x83f1 }, // COMPRESSED_RGBA_S3TC_DXT1
  rgba8: { extension: null, internal: null },
};

const VERTEX = `#version 300 es
void main() {
  // One triangle that covers the viewport.
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

// Each output pixel is the average of a scale x scale block of source texels. Colours are
// weighted by alpha so that the arbitrary colour stored under transparent texels does not
// bleed into the icon's edge.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform ivec2 source;   // top-left texel of the icon in the atlas
uniform ivec2 target;   // bottom-left pixel of the cell in the sheet
uniform int cell;
uniform int scale;
out vec4 color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - target;
  ivec2 base = source + ivec2(p.x, cell - 1 - p.y) * scale;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < scale; y++) {
    for (int x = 0; x < scale; x++) {
      vec4 texel = texelFetch(atlas, base + ivec2(x, y), 0);
      sum += vec4(texel.rgb * texel.a, texel.a);
    }
  }
  float alpha = sum.a / float(scale * scale);
  color = vec4(sum.a > 0.0 ? sum.rgb / sum.a : vec3(0.0), alpha);
}`;

export class IconBuildError extends Error {}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new IconBuildError(gl.getShaderInfoLog(shader));
  return shader;
}

/**
 * @param {(method: string, path: string, body?: object) => Promise<any>} api  JSON calls to the server
 * @param {(path: string, init?: RequestInit) => Promise<Response>} request     raw calls carrying the session token
 * @returns {Promise<number>} how many items now have an icon
 */
export async function buildIconSheet(api, request) {
  const plan = await api('POST', '/api/icons/plan');
  const canvas = document.createElement('canvas');
  canvas.width = plan.columns * plan.cell;
  canvas.height = plan.rows * plan.cell;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new IconBuildError('이 창에서는 그래픽 가속(WebGL)을 쓸 수 없어서 아이콘을 만들 수 없어요.');
  for (const texture of plan.textures) {
    const format = GL_FORMATS[texture.format];
    if (!format || (format.extension && !gl.getExtension(format.extension))) {
      throw new IconBuildError('이 PC의 그래픽 드라이버가 게임 텍스처 형식을 지원하지 않아서 아이콘을 만들 수 없어요.');
    }
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new IconBuildError(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('atlas'), 0);
  gl.uniform1i(uniform('cell'), plan.cell);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  for (const [index, texture] of plan.textures.entries()) {
    const response = await request(`/api/icons/texture?index=${index}`);
    if (!response.ok) throw new IconBuildError('게임 텍스처를 읽지 못했어요.');
    const data = new Uint8Array(await response.arrayBuffer());
    const handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const format = GL_FORMATS[texture.format];
    if (format.internal) gl.compressedTexImage2D(gl.TEXTURE_2D, 0, format.internal, texture.width, texture.height, 0, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texture.width, texture.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    plan.sprites.forEach(([owner, x, y, size], slot) => {
      if (owner !== index) return;
      const left = (slot % plan.columns) * plan.cell;
      const bottom = canvas.height - (Math.floor(slot / plan.columns) + 1) * plan.cell;
      gl.viewport(left, bottom, plan.cell, plan.cell);
      gl.uniform2i(uniform('source'), x, y);
      gl.uniform2i(uniform('target'), left, bottom);
      gl.uniform1i(uniform('scale'), Math.max(1, Math.round(size / plan.cell)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    gl.deleteTexture(handle);
  }
  if (gl.getError() !== gl.NO_ERROR) throw new IconBuildError('아이콘을 그리는 중에 그래픽 오류가 났어요.');

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new IconBuildError('아이콘 시트를 이미지로 만들지 못했어요.');
  const saved = await request('/api/icons/sheet', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  if (!saved.ok) throw new IconBuildError('아이콘 시트를 저장하지 못했어요.');
  return (await saved.json()).icons;
}
