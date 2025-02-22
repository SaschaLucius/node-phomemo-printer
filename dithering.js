/**
 * dithering.js
 *
 * A Node.js library for applying various algorithms to an image.
 * The input “image” must follow the PNG imageData spec:
 *    - image.width: image width (pixels)
 *    - image.height: image height (pixels)
 *    - image.data: a flat array (or Uint8ClampedArray) of RGBA values
 *
 * Available algorithms:
 *    - FLOYD_STEINBERG
 *    - ATKINSON
 *    - THRESHOLD
 *    - BURKES
 *    - DIFFUSION_ROW
 *    - DIFFUSION_COLUMN
 *    - DIFFUSION_2D
 *    - JARVIS_JUDICE_NINKE
 *    - SIERRA2
 *    - STUCKI
 *    - CUSTOM
 *    - GRAYSCALE  <-- New: converts the image to grayscale only without dithering.
 *
 * License: MIT
 */

export const ALGORITHMS = {
  FLOYD_STEINBERG: "FLOYD_STEINBERG",
  ATKINSON: "ATKINSON",
  THRESHOLD: "THRESHOLD",
  BURKES: "BURKES",
  DIFFUSION_ROW: "DIFFUSION_ROW",
  DIFFUSION_COLUMN: "DIFFUSION_COLUMN",
  DIFFUSION_2D: "DIFFUSION_2D",
  JARVIS_JUDICE_NINKE: "JARVIS_JUDICE_NINKE",
  SIERRA2: "SIERRA2",
  STUCKI: "STUCKI",
  CUSTOM: "CUSTOM",
  GRAYSCALE: "GRAYSCALE"
};

/**
 * dither(image, algorithm, options)
 *
 * Applies the selected algorithm to the image.
 *
 * @param {Object} image - An object with width, height, and data (RGBA flat array).
 * @param {String} algorithm - One of the ALGORITHMS keys.
 * @param {Object} [options] - For CUSTOM algorithm, options.custom must be a function(image).
 * @returns {Object} The modified image.
 */
export function dither(image, algorithm, options = {}) {
  switch (algorithm) {
    case ALGORITHMS.FLOYD_STEINBERG:
      return floydSteinberg(image);
    case ALGORITHMS.ATKINSON:
      return atkinson(image);
    case ALGORITHMS.THRESHOLD:
      return threshold(image);
    case ALGORITHMS.BURKES:
      return burkes(image);
    case ALGORITHMS.DIFFUSION_ROW:
      return diffusionRow(image);
    case ALGORITHMS.DIFFUSION_COLUMN:
      return diffusionColumn(image);
    case ALGORITHMS.DIFFUSION_2D:
      return diffusion2D(image);
    case ALGORITHMS.JARVIS_JUDICE_NINKE:
      return jarvisJudiceNinke(image);
    case ALGORITHMS.SIERRA2:
      return sierra2(image);
    case ALGORITHMS.STUCKI:
      return stucki(image);
    case ALGORITHMS.CUSTOM:
      if (typeof options.custom === "function") {
        return options.custom(image);
      }
      throw new Error("For CUSTOM algorithm, supply a custom function in options.custom");
    case ALGORITHMS.GRAYSCALE:  // New case: Grayscale-only
      toGrayscale(image);
      return image;
    default:
      throw new Error("Unknown algorithm: " + algorithm);
  }
}

/**
 * Converts the image to grayscale.
 */
function toGrayscale(image) {
  const data = image.data;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const lum = Math.floor(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
}

/**
 * Error diffusion helper.
 * Applies the given kernel (array of [dx,dy,weight] values) with a divisor.
 */
function errorDiffusion(image, kernel, divisor) {
  const { width: w, height: h, data } = image;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const oldPixel = data[idx];
      const newPixel = oldPixel < 128 ? 0 : 255;
      const error = oldPixel - newPixel;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
      for (const [dx, dy, weight] of kernel) {
        addError(data, w, h, x + dx, y + dy, error, weight / divisor);
      }
    }
  }
  return image;
}

/**
 * Helper: Add error to a pixel if within bounds.
 */
function addError(data, w, h, x, y, error, factor) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const idx = (y * w + x) * 4;
  let newVal = data[idx] + error * factor;
  newVal = Math.max(0, Math.min(255, newVal));
  data[idx] = data[idx + 1] = data[idx + 2] = newVal;
}

/**
 * Floyd-Steinberg algorithm.
 */
function floydSteinberg(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 7],
    [-1, 1, 3],
    [0, 1, 5],
    [1, 1, 1]
  ], 16);
}

/**
 * Atkinson algorithm.
 */
function atkinson(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 1],
    [2, 0, 1],
    [-1, 1, 1],
    [0, 1, 1],
    [1, 1, 1],
    [0, 2, 1]
  ], 8);
}

/**
 * Threshold algorithm.
 */
function threshold(image) {
  toGrayscale(image);
  const data = image.data, len = data.length;
  for (let i = 0; i < len; i += 4) {
    const newPixel = data[i] < 128 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = newPixel;
  }
  return image;
}

/**
 * Burkes algorithm.
 */
function burkes(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 8],
    [2, 0, 4],
    [-2, 1, 2],
    [-1, 1, 4],
    [0, 1, 8],
    [1, 1, 4],
    [2, 1, 2]
  ], 32);
}

/**
 * Diffusion Row: Diffuse error horizontally.
 */
function diffusionRow(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 1],
    [2, 0, 1]
  ], 2);
}

/**
 * Diffusion Column: Diffuse error vertically.
 */
function diffusionColumn(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [0, 1, 1],
    [0, 2, 1]
  ], 2);
}

/**
 * Diffusion 2D: A simple two-dimensional diffusion.
 */
function diffusion2D(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 3],
    [-1, 1, 2],
    [0, 1, 3],
    [1, 1, 2]
  ], 10);
}

/**
 * Jarvis, Judice, Ninke algorithm.
 */
function jarvisJudiceNinke(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 7],
    [2, 0, 5],
    [-2, 1, 3],
    [-1, 1, 5],
    [0, 1, 7],
    [1, 1, 5],
    [2, 1, 3],
    [-2, 2, 1],
    [-1, 2, 3],
    [0, 2, 5],
    [1, 2, 3],
    [2, 2, 1]
  ], 48);
}

/**
 * Sierra2 algorithm.
 */
function sierra2(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 4],
    [2, 0, 3],
    [-2, 1, 1],
    [-1, 1, 2],
    [0, 1, 3],
    [1, 1, 2],
    [2, 1, 1],
    [-1, 2, 1],
    [0, 2, 2],
    [1, 2, 1]
  ], 12);
}

/**
 * Stucki algorithm.
 */
function stucki(image) {
  toGrayscale(image);
  return errorDiffusion(image, [
    [1, 0, 8],
    [2, 0, 4],
    [-2, 1, 2],
    [-1, 1, 4],
    [0, 1, 8],
    [1, 1, 4],
    [2, 1, 2],
    [-2, 2, 1],
    [-1, 2, 2],
    [0, 2, 4],
    [1, 2, 2],
    [2, 2, 1]
  ], 42);
}
