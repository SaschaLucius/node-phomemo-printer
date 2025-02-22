/**
 * dithering.js
 *
 * A Node.js library for applying various dithering algorithms to an image.
 * The input “image” must follow the PNG imageData spec:
 *   - image.width: image width (pixels)
 *   - image.height: image height (pixels)
 *   - image.data: a flat array (or Uint8ClampedArray) of RGBA values
 *
 * Available algorithms:
 *   - FLOYD_STEINBERG
 *   - ATKINSON
 *   - THRESHOLD
 *
 * To add more algorithms (e.g. BURKES, etc.), follow the pattern below.
 *
 * License: MIT
 */

export const ALGORITHMS = {
  FLOYD_STEINBERG: "FLOYD_STEINBERG",
  ATKINSON: "ATKINSON",
  THRESHOLD: "THRESHOLD",
  // You can add more names here…
  CUSTOM: "CUSTOM"
};

/**
 * dither(image, algorithm, options)
 *
 * Applies the selected dithering algorithm to the image.
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
    case ALGORITHMS.CUSTOM:
      if (typeof options.custom === "function") {
        return options.custom(image);
      }
      throw new Error("For CUSTOM algorithm, supply a custom function in options.custom");
    default:
      throw new Error("Unknown dithering algorithm: " + algorithm);
  }
}

/**
 * Helper: Distribute error to a pixel if within bounds.
 */
function addError(data, w, h, x, y, error, factor) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const idx = (y * w + x) * 4;
  let newVal = data[idx] + error * factor;
  newVal = Math.max(0, Math.min(255, newVal));
  data[idx] = newVal;
  data[idx + 1] = newVal;
  data[idx + 2] = newVal;
}

/**
 * Floyd-Steinberg algorithm.
 * Converts image to grayscale first, then diffuses error.
 */
function floydSteinberg(image) {
  const data = image.data;
  const w = image.width;
  const h = image.height;
  const len = data.length;
  // Convert to grayscale using standard luminance factors.
  for (let i = 0; i < len; i += 4) {
    const lum = Math.floor(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
  // Process each pixel and diffuse the error.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const oldPixel = data[idx];
      const newPixel = oldPixel < 150 ? 0 : 255;
      const error = oldPixel - newPixel;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
      addError(data, w, h, x + 1, y, error, 7 / 16);
      addError(data, w, h, x - 1, y + 1, error, 3 / 16);
      addError(data, w, h, x, y + 1, error, 5 / 16);
      addError(data, w, h, x + 1, y + 1, error, 1 / 16);
    }
  }
  return image;
}

/**
 * Atkinson algorithm.
 * Diffuses error equally to six neighboring pixels.
 */
function atkinson(image) {
  const data = image.data;
  const w = image.width;
  const h = image.height;
  const len = data.length;
  // Convert to grayscale.
  for (let i = 0; i < len; i += 4) {
    const lum = Math.floor(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
  // Process each pixel.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const oldPixel = data[idx];
      const newPixel = oldPixel < 128 ? 0 : 255;
      const error = oldPixel - newPixel;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
      // Diffuse error equally (weight = 1/8) to 6 neighbors.
      addError(data, w, h, x + 1, y, error, 1 / 8);
      addError(data, w, h, x + 2, y, error, 1 / 8);
      addError(data, w, h, x - 1, y + 1, error, 1 / 8);
      addError(data, w, h, x, y + 1, error, 1 / 8);
      addError(data, w, h, x + 1, y + 1, error, 1 / 8);
      addError(data, w, h, x, y + 2, error, 1 / 8);
    }
  }
  return image;
}

/**
 * Threshold algorithm.
 * Simply converts each pixel to black or white.
 */
function threshold(image) {
  const data = image.data;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const lum = Math.floor(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const newPixel = lum < 128 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = newPixel;
  }
  return image;
}
