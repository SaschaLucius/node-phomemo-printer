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
 *    - ORDERED_BAYER  <-- New: ordered dithering using a Bayer matrix.
 *    - RANDOM         <-- New: random dithering using a random threshold per pixel.
 *    - DITHERPUNK     <-- New: noise-injected threshold dithering.
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
  // CUSTOM: "CUSTOM",
  GRAYSCALE: "GRAYSCALE",
  ORDERED_BAYER: "ORDERED_BAYER", // New
  RANDOM: "RANDOM", // New
  DITHERPUNK: "DITHERPUNK", // New
  EVEN_TONED_SCREENING: "EVEN_TONED_SCREENING", // New
  SIMPLE_EVEN_TONED_SCREENING: "SIMPLE_EVEN_TONED_SCREENING", // New: simplified ETS variant
  EVEN_BETTER_SCREENING: "EVEN_BETTER_SCREENING", // New: simplified EBS variant
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
      return floydSteinberg(image, options);
    case ALGORITHMS.ATKINSON:
      return atkinson(image, options);
    case ALGORITHMS.THRESHOLD:
      return threshold(image);
    case ALGORITHMS.BURKES:
      return burkes(image, options);
    case ALGORITHMS.DIFFUSION_ROW:
      return diffusionRow(image, options);
    case ALGORITHMS.DIFFUSION_COLUMN:
      return diffusionColumn(image, options);
    case ALGORITHMS.DIFFUSION_2D:
      return diffusion2D(image, options);
    case ALGORITHMS.JARVIS_JUDICE_NINKE:
      return jarvisJudiceNinke(image, options);
    case ALGORITHMS.SIERRA2:
      return sierra2(image, options);
    case ALGORITHMS.STUCKI:
      return stucki(image, options);
    case ALGORITHMS.CUSTOM:
      if (typeof options.custom === "function") {
        return options.custom(image);
      }
      throw new Error(
        "For CUSTOM algorithm, supply a custom function in options.custom"
      );
    case ALGORITHMS.GRAYSCALE:
      toGrayscale(image);
      return image;
    case ALGORITHMS.ORDERED_BAYER:
      return orderedBayer(image);
    case ALGORITHMS.RANDOM:
      return randomDither(image);
    case ALGORITHMS.DITHERPUNK:
      return ditherpunk(image);
    case ALGORITHMS.EVEN_TONED_SCREENING:
      return evenTonedScreening(image, options);
    case ALGORITHMS.SIMPLE_EVEN_TONED_SCREENING:
      return simpleEvenTonedScreening(image);
    case ALGORITHMS.EVEN_BETTER_SCREENING:
      return evenBetterScreening(image, options);
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
    const lum = Math.floor(
      0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    );
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
}

/**
 * Error diffusion helper.
 * Applies the given kernel (array of [dx, dy, weight] values) with a divisor.
 * Supports serpentine scanning: when enabled, on odd rows pixels are processed
 * right-to-left and the dx offsets are reversed.
 */
function errorDiffusion(image, kernel, divisor, serpentine = false) {
  const { width: w, height: h, data } = image;
  for (let y = 0; y < h; y++) {
    const reverse = serpentine && y % 2 === 1;
    if (reverse) {
      for (let x = w - 1; x >= 0; x--) {
        const idx = (y * w + x) * 4;
        const oldPixel = data[idx];
        const newPixel = oldPixel < 128 ? 0 : 255;
        const error = oldPixel - newPixel;
        data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
        for (const [dx, dy, weight] of kernel) {
          // Mirror x offset on reversed scan
          const effectiveDx = -dx;
          addError(
            data,
            w,
            h,
            x + effectiveDx,
            y + dy,
            error,
            weight / divisor
          );
        }
      }
    } else {
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
function floydSteinberg(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
    16,
    serpentine
  );
}

/**
 * Atkinson algorithm.
 */
function atkinson(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
    8,
    serpentine
  );
}

/**
 * Threshold algorithm using the image's median luminance as the threshold.
 * It converts the image to grayscale, computes the median value across all pixels,
 * and then thresholds each pixel against that median value.
 */
function threshold(image) {
  // Convert image to grayscale.
  toGrayscale(image);
  const data = image.data;
  const len = data.length;
  const pixelCount = len / 4;
  const values = new Array(pixelCount);

  // Collect all grayscale pixel values.
  for (let i = 0, j = 0; i < len; i += 4, j++) {
    values[j] = data[i];
  }

  // Sort the values.
  values.sort((a, b) => a - b);

  // Compute the median.
  let median;
  if (pixelCount % 2 === 1) {
    median = values[Math.floor(pixelCount / 2)];
  } else {
    const mid = pixelCount / 2;
    median = (values[mid - 1] + values[mid]) / 2;
  }

  // Apply thresholding using the computed median.
  for (let i = 0; i < len; i += 4) {
    const newPixel = data[i] < median ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = newPixel;
  }

  return image;
}

/**
 * Burkes algorithm.
 */
function burkes(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
    ],
    32,
    serpentine
  );
}

/**
 * Diffusion Row: Diffuse error horizontally.
 */
function diffusionRow(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 1],
      [2, 0, 1],
    ],
    2,
    serpentine
  );
}

/**
 * Diffusion Column: Diffuse error vertically.
 */
function diffusionColumn(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [0, 1, 1],
      [0, 2, 1],
    ],
    2,
    serpentine
  );
}

/**
 * Diffusion 2D: A simple two-dimensional diffusion.
 */
function diffusion2D(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 3],
      [-1, 1, 2],
      [0, 1, 3],
      [1, 1, 2],
    ],
    10,
    serpentine
  );
}

/**
 * Jarvis, Judice, Ninke algorithm.
 */
function jarvisJudiceNinke(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
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
      [2, 2, 1],
    ],
    48,
    serpentine
  );
}

/**
 * Sierra2 algorithm.
 */
function sierra2(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
      [1, 0, 4],
      [2, 0, 3],
      [-2, 1, 1],
      [-1, 1, 2],
      [0, 1, 3],
      [1, 1, 2],
      [2, 1, 1],
      [-1, 2, 1],
      [0, 2, 2],
      [1, 2, 1],
    ],
    12,
    serpentine
  );
}

/**
 * Stucki algorithm.
 */
function stucki(image, opts = {}) {
  toGrayscale(image);
  const serpentine = !!opts.serpentine;
  return errorDiffusion(
    image,
    [
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
      [2, 2, 1],
    ],
    42,
    serpentine
  );
}

/* ===================== New Algorithms ===================== */

/**
 * Ordered Bayer dithering.
 * Uses a 4x4 Bayer matrix to threshold pixels in an ordered pattern.
 */
function orderedBayer(image) {
  toGrayscale(image);
  const data = image.data;
  const w = image.width,
    h = image.height;
  const bayerMatrix = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const matrixSize = 4;
  // The matrix values range from 0 to 15. We map these to thresholds [0,255]
  const scale = 255 / (matrixSize * matrixSize);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Determine threshold from the Bayer matrix and add half the step to center it
      const threshold =
        (bayerMatrix[y % matrixSize][x % matrixSize] + 0.5) * scale;
      const oldPixel = data[idx];
      const newPixel = oldPixel < threshold ? 0 : 255;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
    }
  }
  return image;
}

/**
 * Random dithering.
 * Each pixel is compared against a random threshold.
 */
function randomDither(image) {
  toGrayscale(image);
  const data = image.data;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const threshold = Math.random() * 255;
    const oldPixel = data[i];
    const newPixel = oldPixel < threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = newPixel;
  }
  return image;
}

/**
 * Ditherpunk algorithm.
 * A creative twist on threshold dithering by adding noise before thresholding.
 */
function ditherpunk(image) {
  toGrayscale(image);
  const data = image.data;
  const len = data.length;
  // Add noise to each pixel and then threshold
  for (let i = 0; i < len; i += 4) {
    // Add noise in the range [-64, 64]
    const noise = (Math.random() - 0.5) * 128;
    const noisyPixel = data[i] + noise;
    const newPixel = noisyPixel < 128 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = newPixel;
  }
  return image;
}

/**
 * Even Toned Screening.
 * Converts the image to grayscale and applies an even-toned screening
 * using a generated screening matrix. The matrix is generated by ranking
 * the positions in an N×N block by their distance from the center.
 *
 * Options:
 *    - matrixSize (default: 8)
 */
function evenTonedScreening(image, opts = {}) {
  toGrayscale(image);
  const matrixSize = opts.matrixSize || 8;
  // Generate the screening matrix (could be cached for performance)
  const screeningMatrix = generateEvenTonedMatrix(matrixSize);
  const data = image.data;
  const w = image.width,
    h = image.height;
  const numCells = matrixSize * matrixSize;
  // Normalize so that the maximum rank (numCells-1) maps to 255.
  const scale = 255 / (numCells - 1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Use the screening matrix (tile it over the image)
      const cell = screeningMatrix[y % matrixSize][x % matrixSize];
      // Compute the threshold; add 0.5 to center the mapping.
      const threshold = (cell + 0.5) * scale;
      const oldPixel = data[idx];
      const newPixel = oldPixel < threshold ? 0 : 255;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;
    }
  }
  return image;
}

/**
 * Generates an even-toned screening matrix.
 * The matrix is an N×N array where each element is the rank (from 0 to N²-1)
 * of its cell when the cells are sorted by their Euclidean distance from the center.
 */
function generateEvenTonedMatrix(N) {
  const matrix = Array.from({ length: N }, () => Array(N).fill(0));
  const cells = [];
  const center = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const dist = Math.sqrt((i - center) ** 2 + (j - center) ** 2);
      cells.push({ i, j, dist });
    }
  }
  // Sort cells by distance (and by i,j for ties)
  cells.sort((a, b) => a.dist - b.dist || a.i - b.i || a.j - b.j);
  // Assign increasing ranks
  for (let rank = 0; rank < cells.length; rank++) {
    const { i, j } = cells[rank];
    matrix[i][j] = rank;
  }
  return matrix;
}

/**
 * Revised Simple Even Toned Screening.
 * A simplified variant that uses per-row error buffers to adjust the local threshold.
 * It converts the image to grayscale then, for each pixel, adds the accumulated error
 * from a buffer and adjusts the threshold accordingly.
 *
 * The error is diffused using Floyd–Steinberg weights.
 */
function simpleEvenTonedScreening(image) {
  toGrayscale(image);
  const { width: w, height: h, data } = image;
  // Initialize error buffers for current and next row
  let curRow = new Array(w).fill(0);
  let nextRow = new Array(w).fill(0);
  const biasFactor = 0.25; // How much of the pixel's error biases the threshold

  for (let y = 0; y < h; y++) {
    // For each new row, start with the current row error (from previous row diffusion)
    // and reset the next row buffer.
    for (let x = 0; x < w; x++) {
      // Get the original pixel value and add local error from buffer.
      const idx = (y * w + x) * 4;
      let value = data[idx] + curRow[x];

      // Adjust threshold slightly based on the local error.
      let threshold = 128 + curRow[x] * biasFactor;
      threshold = Math.max(0, Math.min(255, threshold));

      // Quantize the pixel.
      const newPixel = value < threshold ? 0 : 255;
      const error = value - newPixel;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;

      // Diffuse error using simplified Floyd–Steinberg weights.
      if (x + 1 < w) {
        curRow[x + 1] += error * (7 / 16);
      }
      if (y + 1 < h) {
        nextRow[x] += error * (5 / 16);
        if (x + 1 < w) {
          nextRow[x + 1] += error * (1 / 16);
        }
      }
    }
    // Prepare for the next row.
    curRow = nextRow.slice(); // shallow copy of nextRow
    nextRow.fill(0);
  }

  return image;
}

/**
 * evenBetterScreening(image, opts)
 *
 * A simplified Even Better Screening implementation inspired by the C version.
 * It uses a threshold modulation (TM) array to modulate the quantization threshold
 * and error diffusion (Floyd–Steinberg) to diffuse residual error.
 *
 * Options:
 *   - levels: number of output levels (default: 2 for binary screening)
 *   - tmwid: width of the TM array (default: 256)
 *   - tmheight: height of the TM array (default: 256)
 *   - tmmat: a tm array (2D array of signed integers); if not provided, one is generated.
 *            Suggested range for modulation values is about -20 to +20.
 */
function evenBetterScreening(image, opts = {}) {
  // Convert image to grayscale first.
  toGrayscale(image);
  const { width: w, height: h, data } = image;
  const levels = opts.levels || 2; // assuming binary output if not specified
  const tmwid = opts.tmwid || 256;
  const tmheight = opts.tmheight || 256;
  const tmmat = opts.tmmat || generateDefaultTM(tmwid, tmheight);

  // Set up an error buffer for error diffusion.
  let errorBuffer = new Array(w).fill(0);

  // For each scanline…
  for (let y = 0; y < h; y++) {
    let nextError = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Add error from diffusion.
      let value = data[idx] + errorBuffer[x];

      // Get modulation value from our TM array.
      // tmmat is assumed to be a 2D array of numbers in a range like [-20, 20].
      let mod = tmmat[y % tmheight][x % tmwid];
      // Compute modulation-adjusted threshold.
      let threshold = 128 + mod;
      // Clamp threshold to valid range.
      threshold = Math.max(0, Math.min(255, threshold));

      // Quantize pixel.
      const newPixel = value < threshold ? 0 : 255;
      const error = value - newPixel;
      data[idx] = data[idx + 1] = data[idx + 2] = newPixel;

      // Diffuse error as in Floyd–Steinberg.
      if (x + 1 < w) {
        errorBuffer[x + 1] += error * (7 / 16);
      }
      if (y + 1 < h) {
        nextError[x] += error * (5 / 16);
        if (x + 1 < w) {
          nextError[x + 1] += error * (1 / 16);
        }
      }
    }
    // Prepare error buffer for the next row.
    errorBuffer = nextError;
  }
  return image;
}

/**
 * generateDefaultTM(width, height)
 *
 * Generates a default threshold modulation (TM) array.
 * In this example we generate a 2D array filled with pseudo-random values
 * in the approximate range [-20, 20]. You can modify this function to produce
 * more interesting or structured modulation if desired.
 */
function generateDefaultTM(width, height) {
  const tm = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      // Generate a modulation value between -20 and 20.
      row.push(Math.floor(Math.random() * 41) - 20);
    }
    tm.push(row);
  }
  return tm;
}
